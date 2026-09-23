// The shared recommendation engine. This is the ONLY place the recommendation
// logic lives. Both surfaces (the Web API in index.ts and the MCP server in
// mcp.ts) call recommend() and just shape the result.
//
// The input can be a GitHub repo (URL or owner/repo) OR a website URL. Either
// way we produce an Analysis (purpose, stack, search queries), then run the same
// GitHub search and ranking. Recommendations are always GitHub repos.

import {
    parseRepo,
    getRepo,
    getReadme,
    searchRepos,
    getContributorCount,
    getCommitsSince,
    type RepoMeta,
} from "./github";

import {
    callOpenAI,
    parseStructured,
    MODELS,
    type JsonSchemaFormat,
} from "./openai";

export interface EngineEnv {
    OPENAI_API_KEY?: string;
    GITHUB_TOKEN?: string;
}

export class InputError extends Error {}

export interface Recommendation {
    fullName: string;
    url: string;
    stars: number;
    forks: number;
    language: string | null;
    lastUpdated: string | null;
    contributors: number | null;
    velocity90d: number | null;
    whatIsIt: string;
    why: string;
    how: string;
    ratings: {
        easeOfUse: number;
        impact: number;
    };
}

export interface RecommendResult {
    source: {
        fullName: string;
        kind: "repo" | "website";
        purpose: string;
        stack: string[];
    };
    goal: string;
    mode: "openai" | "github-fallback";
    recommendations: Recommendation[];
}

interface Analysis {
    purpose: string;
    stack: string[];
    searchQueries: string[];
}

interface SourceContext extends Analysis {
    fullName: string;
    kind: "repo" | "website";
    langHint?: string;
    exclude?: string;
}

const analysisFormat: JsonSchemaFormat = {
    name: "source_analysis",
    description: "A concise project analysis plus GitHub search queries.",
    schema: {
        type: "object",
        properties: {
            purpose: { type: "string" },
            stack: {
                type: "array",
                items: { type: "string" },
            },
            searchQueries: {
                type: "array",
                minItems: 2,
                maxItems: 3,
                items: { type: "string" },
            },
        },
        required: ["purpose", "stack", "searchQueries"],
        additionalProperties: false,
    },
};

const curationFormat: JsonSchemaFormat = {
    name: "repo_recommendations",
    description:
        "The best complementary repositories and project-specific integration guidance.",
    schema: {
        type: "object",
        properties: {
            recommendations: {
                type: "array",
                minItems: 1,
                maxItems: 5,
                items: {
                    type: "object",
                    properties: {
                        fullName: { type: "string" },
                        whatIsIt: { type: "string" },
                        why: { type: "string" },
                        how: { type: "string" },
                        easeOfUse: {
                            type: "integer",
                            minimum: 1,
                            maximum: 5,
                        },
                        impact: {
                            type: "integer",
                            minimum: 1,
                            maximum: 5,
                        },
                    },
                    required: [
                        "fullName",
                        "whatIsIt",
                        "why",
                        "how",
                        "easeOfUse",
                        "impact",
                    ],
                    additionalProperties: false,
                },
            },
        },
        required: ["recommendations"],
        additionalProperties: false,
    },
};

export async function recommend(
    input: string,
    goal: string,
    env: EngineEnv,
): Promise<RecommendResult> {
    const key = env.OPENAI_API_KEY?.trim();
    const token = env.GITHUB_TOKEN || undefined;

    if (!key) {
        return recommendWithGitHub(input, goal, token);
    }

    try {
        const ctx = await analyzeSource(input, goal, key, token);

        const source = {
            fullName: ctx.fullName,
            kind: ctx.kind,
            purpose: ctx.purpose,
            stack: ctx.stack,
        };

        const candidates = await gatherCandidates(ctx, goal, token);

        if (candidates.length === 0) {
            return {
                source,
                goal,
                mode: "openai",
                recommendations: [],
            };
        }

        const recommendations = await curate(
            ctx,
            goal,
            candidates,
            key,
        );

        await enrichMetrics(recommendations, token);

        return {
            source,
            goal,
            mode: "openai",
            recommendations,
        };
    } catch (error) {
        console.log(
            "OpenAI path failed, using GitHub fallback",
            error instanceof Error
                ? error.message
                : String(error),
        );

        return recommendWithGitHub(
            input,
            goal,
            token,
        );
    }
}

// A deterministic fallback keeps the demo useful when the model provider is
// unavailable. It still uses live GitHub data, ecosystem filtering, maintenance
// checks, and objective metrics.
async function recommendWithGitHub(
    input: string,
    goal: string,
    token?: string,
): Promise<RecommendResult> {
    const repo = parseRepo(input);

    let ctx: SourceContext;

    if (repo) {
        const meta = await getRepo(
            repo.owner,
            repo.repo,
            token,
        );

        ctx = {
            fullName: meta.fullName,
            kind: "repo",
            purpose:
                meta.description ||
                `The ${meta.fullName} GitHub project.`,
            stack: [
                meta.language,
                ...meta.topics.slice(0, 4),
            ].filter(
                (value): value is string =>
                    Boolean(value),
            ),
            searchQueries:
                buildFallbackSearchQueries(goal),
            langHint: meta.language ?? undefined,
            exclude: meta.fullName,
        };
    } else if (looksLikeUrl(input)) {
        const site = await fetchSite(input);

        ctx = {
            fullName: site.host,
            kind: "website",
            purpose:
                site.title ||
                site.text.slice(0, 180) ||
                `The ${site.host} website.`,
            stack: ["website"],
            searchQueries:
                buildFallbackSearchQueries(goal),
        };
    } else {
        throw new InputError(
            "Enter a GitHub repo (URL or owner/repo) or a website URL.",
        );
    }

    const candidates = await gatherCandidates(
        ctx,
        goal,
        token,
    );

    const recommendations =
        rankFallbackCandidates(
            candidates,
            goal,
            ctx.langHint,
        )
            .slice(0, 5)
            .map((candidate) => ({
                fullName: candidate.fullName,
                url: candidate.url,
                stars: candidate.stars,
                forks: candidate.forks,
                language: candidate.language,
                lastUpdated: candidate.pushedAt,
                contributors: null,
                velocity90d: null,
                whatIsIt:
                    candidate.description ||
                    `${candidate.fullName} is an open-source ${candidate.language || "software"} project.`,
                why:
                    `${candidate.fullName} is a widely adopted, actively maintained candidate for ${goal}. ` +
                    `Review its API and license against ${ctx.fullName} before committing to the integration.`,
                how:
                    `Start with the repository quickstart, build a small ${goal} proof of concept, ` +
                    `then validate it against your existing stack.`,
                ratings: {
                    easeOfUse:
                        candidate.stars >= 10_000
                            ? 4
                            : 3,
                    impact: 4,
                },
            }));

    await enrichMetrics(
        recommendations,
        token,
    );

    return {
        source: {
            fullName: ctx.fullName,
            kind: ctx.kind,
            purpose: ctx.purpose,
            stack: ctx.stack,
        },
        goal,
        mode: "github-fallback",
        recommendations,
    };
}

// Fallback results cannot rely on model judgment, so direct capability fit
// must outweigh raw popularity.
export function rankFallbackCandidates<
    T extends Pick<
        RepoMeta,
        | "fullName"
        | "description"
        | "topics"
        | "stars"
        | "archived"
    >,
>(
    candidates: T[],
    goal: string,
    sourceLanguage?: string,
): T[] {
    const baseTerms =
        goal
            .toLowerCase()
            .match(/[a-z0-9]+/g)
            ?.filter(
                (term) => term.length >= 3,
            ) ?? [];

    const aliases: Record<
        string,
        string[]
    > = {
        authentication: ["auth"],
        authorization: ["auth"],
        evaluations: ["eval"],
        evaluation: ["eval"],
        evals: ["eval"],
        observability: [
            "telemetry",
            "tracing",
        ],
    };

    const terms = [
        ...new Set(
            baseTerms.flatMap((term) => [
                term,
                ...(aliases[term] ?? []),
            ]),
        ),
    ];

    const score = (
        candidate: T,
    ): number => {
        const name =
            candidate.fullName.toLowerCase();

        const description =
            (
                candidate.description ?? ""
            ).toLowerCase();

        const topics = candidate.topics
            .join(" ")
            .toLowerCase();

        let value =
            Math.log10(
                candidate.stars + 1,
            ) * 8;

        for (const term of terms) {
            if (name.includes(term)) {
                value += 100;
            }

            if (topics.includes(term)) {
                value += 40;
            }

            if (
                description.includes(term)
            ) {
                value += 15;
            }
        }

        if (
            /^(typescript|javascript)$/i.test(
                sourceLanguage ?? "",
            ) &&
            /\b(laravel|django|rails|spring|symfony|wordpress)\b/.test(
                name,
            )
        ) {
            value -= 180;
        }

        if (candidate.archived) {
            value -= 200;
        }

        return value;
    };

    return [...candidates].sort(
        (a, b) => score(b) - score(a),
    );
}

// Step 1: figure out what the input is and extract purpose,
// stack, and search queries with the extraction model.
async function analyzeSource(
    input: string,
    goal: string,
    key: string,
    token?: string,
): Promise<SourceContext> {
    const repo = parseRepo(input);

    if (repo) {
        const meta = await getRepo(
            repo.owner,
            repo.repo,
            token,
        );

        const readme = await getReadme(
            repo.owner,
            repo.repo,
            token,
        );

        const analysis =
            await analyzeRepo(
                meta,
                readme,
                goal,
                key,
            );

        return {
            ...analysis,
            fullName: meta.fullName,
            kind: "repo",
            langHint:
                meta.language ??
                undefined,
            exclude: meta.fullName,
        };
    }

    if (looksLikeUrl(input)) {
        const site =
            await fetchSite(input);

        const analysis =
            await analyzeSite(
                site,
                goal,
                key,
            );

        return {
            ...analysis,
            fullName: site.host,
            kind: "website",
        };
    }

    throw new InputError(
        "Enter a GitHub repo (URL or owner/repo) or a website URL.",
    );
}

async function analyzeRepo(
    meta: RepoMeta,
    readme: string,
    goal: string,
    apiKey: string,
): Promise<Analysis> {
    const instructions =
        "Analyze the repository for a developer choosing complementary open-source software.";

    const user = [
        `Repo: ${meta.fullName}`,
        `Description: ${meta.description ?? "(none)"}`,
        `Primary language: ${meta.language ?? "(unknown)"}`,
        `Topics: ${meta.topics.join(", ") || "(none)"}`,
        "",
        "README excerpt:",
        readme.slice(0, 4000) ||
            "(no README)",
        "",
        `The user wants to improve this project with: "${goal}".`,
        "",
        "Return a concise purpose, the important stack, and 2 or 3 short canonical GitHub search queries.",
    ].join("\n");

    return parseAnalysis(
        await callOpenAI({
            apiKey,
            model: MODELS.extract,
            instructions,
            input: user,
            maxOutputTokens: 500,
            reasoningEffort: "none",
            schema: analysisFormat,
        }),
    );
}

async function analyzeSite(
    site: {
        host: string;
        title: string;
        text: string;
    },
    goal: string,
    apiKey: string,
): Promise<Analysis> {
    const instructions =
        "Analyze the website for a developer choosing complementary open-source software.";

    const user = [
        `Website: ${site.host}`,
        `Title: ${site.title || "(none)"}`,
        "",
        "Page content (text excerpt):",
        site.text.slice(0, 4000) ||
            "(no readable content)",
        "",
        `The user wants to add or improve: "${goal}".`,
        "",
        "Return a concise purpose, the important stack or themes, and 2 or 3 short canonical GitHub search queries.",
    ].join("\n");

    return parseAnalysis(
        await callOpenAI({
            apiKey,
            model: MODELS.extract,
            instructions,
            input: user,
            maxOutputTokens: 500,
            reasoningEffort: "none",
            schema: analysisFormat,
        }),
    );
}

function parseAnalysis(
    text: string,
): Analysis {
    return parseStructured<Analysis>(
        text,
    );
}

// Convert a human goal into a small set of GitHub-friendly search queries.
// GitHub repository search ANDs terms together, so long natural-language
// requests tend to become overly restrictive and return no results.
export function buildFallbackSearchQueries(
    goal: string,
): string[] {
    const normalized = goal
        .replace(/[_/]+/g, " ")
        .replace(
            /[^\w\s+#.,-]/g,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim();

    if (!normalized) {
        return [];
    }

    const stopWords = new Set([
        "a",
        "an",
        "the",
        "for",
        "to",
        "of",
        "that",
        "which",
        "please",
        "find",
        "recommend",
        "recommended",
        "recommendation",
        "recommendations",
        "complement",
        "complementary",
        "repository",
        "repositories",
        "repo",
        "repos",
        "project",
        "projects",
        "software",
    ]);

    const cleanClause = (
        value: string,
    ): string =>
        value
            .replace(
                /[^\w\s+#.-]/g,
                " ",
            )
            .split(/\s+/)
            .filter(Boolean)
            .filter(
                (word) =>
                    !stopWords.has(
                        word.toLowerCase(),
                    ),
            )
            .slice(0, 4)
            .join(" ")
            .trim();

    const meaningfulWords =
        normalized
            .split(/\s+/)
            .filter(Boolean)
            .filter(
                (word) =>
                    !stopWords.has(
                        word.toLowerCase(),
                    ),
            );

    // Preserve short goals such as "memory" and "MCP tools".
    if (
        meaningfulWords.length <= 4
    ) {
        const short =
            meaningfulWords
                .join(" ")
                .trim();

        return short
            ? [short]
            : [];
    }

    // Split common natural-language request structures into capability clauses.
    const clauses = normalized
        .split(
            /\s+(?:with|and|or|plus|including|using)\s+|,\s*/,
        )
        .map(cleanClause)
        .filter(Boolean);

    const uniqueClauses = [
        ...new Set(clauses),
    ];

    const anchor =
        uniqueClauses.find(
            (clause) =>
                clause
                    .split(/\s+/)
                    .length >= 2,
        ) ??
        uniqueClauses[0] ??
        meaningfulWords
            .slice(0, 3)
            .join(" ");

    const queries: string[] = [];

    const add = (
        query: string,
    ): void => {
        const cleaned = query
            .replace(/\s+/g, " ")
            .trim();

        if (!cleaned) {
            return;
        }

        const key =
            cleaned.toLowerCase();

        if (
            queries.some(
                (existing) =>
                    existing.toLowerCase() ===
                    key,
            )
        ) {
            return;
        }

        queries.push(cleaned);
    };

    add(anchor);

    for (
        const clause of uniqueClauses
    ) {
        if (queries.length >= 4) {
            break;
        }

        if (
            clause.toLowerCase() ===
            anchor.toLowerCase()
        ) {
            continue;
        }

        const clauseWords =
            clause.split(/\s+/);

        if (
            clauseWords.length <= 2
        ) {
            const anchorWords =
                anchor
                    .split(/\s+/)
                    .slice(0, 3);

            add(
                [
                    ...anchorWords,
                    ...clauseWords,
                ]
                    .slice(0, 4)
                    .join(" "),
            );
        } else {
            add(clause);
        }
    }

    // Safety net if clause splitting produced too little useful material.
    if (queries.length < 2) {
        add(
            meaningfulWords
                .slice(0, 3)
                .join(" "),
        );

        add(
            meaningfulWords
                .slice(-3)
                .join(" "),
        );
    }

    return queries.slice(0, 4);
}

// Step 2: gather complement candidates from several canonical queries.
// GitHub ANDs every word, so several short queries work better than one
// long natural-language request.
async function gatherCandidates(
    ctx: SourceContext,
    goal: string,
    token?: string,
): Promise<RepoMeta[]> {
    const allowed =
        ecosystemLanguages(
            ctx.langHint,
        );

    const ecoLangs = allowed
        ? [...allowed]
        : [];

    const canonicalQueries:
        string[] = [];

    const seenCanonical =
        new Set<string>();

    const addCanonical = (
        query: string,
    ): void => {
        const cleaned =
            query.trim();

        if (!cleaned) {
            return;
        }

        const key =
            cleaned.toLowerCase();

        if (
            seenCanonical.has(key)
        ) {
            return;
        }

        seenCanonical.add(key);
        canonicalQueries.push(
            cleaned,
        );
    };

    for (
        const query of ctx.searchQueries.slice(
            0,
            3,
        )
    ) {
        for (
            const compact of buildFallbackSearchQueries(
                query,
            )
        ) {
            addCanonical(compact);
        }
    }

    for (
        const compact of buildFallbackSearchQueries(
            goal,
        )
    ) {
        addCanonical(compact);
    }

    const baseQueries =
        canonicalQueries.slice(
            0,
            4,
        );

    let queries: string[];

    if (ecoLangs.length > 0) {
        queries =
            baseQueries.flatMap(
                (query) =>
                    ecoLangs.map(
                        (language) =>
                            `${query} language:"${language}"`,
                    ),
            );
    } else {
        queries = baseQueries;
    }

    const merged =
        new Map<
            string,
            RepoMeta
        >();

    const seenQuery =
        new Set<string>();

    for (const raw of queries) {
        const q =
            (raw ?? "").trim();

        if (
            !q ||
            seenQuery.has(q)
        ) {
            continue;
        }

        seenQuery.add(q);

        if (
            seenQuery.size > 6
        ) {
            break;
        }

        let hits: RepoMeta[] = [];

        try {
            hits =
                await searchRepos(
                    q,
                    token,
                    8,
                    ctx.exclude,
                );
        } catch (error) {
            console.warn(
                `GitHub search failed for "${q}": ${
                    error instanceof Error
                        ? error.message
                        : String(error)
                }`,
            );

            continue;
        }

        for (const h of hits) {
            const key =
                h.fullName.toLowerCase();

            if (!merged.has(key)) {
                merged.set(
                    key,
                    h,
                );
            }
        }
    }

    const pool = [
        ...merged.values(),
    ];

    const inEco = allowed
        ? pool.filter(
              (repo) =>
                  repo.language &&
                  allowed.has(
                      repo.language.toLowerCase(),
                  ),
          )
        : pool;

    const ecoPool =
        inEco.length >= 3
            ? inEco
            : pool;

    const tools =
        ecoPool.filter(
            (repo) =>
                !looksLikeNonTool(
                    repo,
                ),
        );

    const usable =
        tools.length >= 3
            ? tools
            : ecoPool;

    const live =
        usable.filter(
            (repo) =>
                !repo.archived,
        );

    const finalPool =
        live.length >= 3
            ? live
            : usable;

    return finalPool
        .sort(
            (a, b) =>
                b.stars - a.stars,
        )
        .slice(0, 12);
}

// Languages whose tools can realistically be used together.
export function ecosystemLanguages(
    lang?: string | null,
): Set<string> | null {
    if (!lang) {
        return null;
    }

    const l =
        lang.toLowerCase();

    const groups: string[][] = [
        [
            "typescript",
            "javascript",
        ],
        ["python"],
        ["go"],
        ["rust"],
        ["ruby"],
        [
            "java",
            "kotlin",
            "scala",
        ],
        ["c#", "f#"],
        ["php"],
        ["c++", "c"],
        [
            "swift",
            "objective-c",
        ],
        [
            "elixir",
            "erlang",
        ],
        ["dart"],
    ];

    const group =
        groups.find((g) =>
            g.includes(l),
        );

    return new Set(
        group ?? [l],
    );
}

// Repos that are learning material or curated lists, not installable tools.
const NON_TOOL_PATTERN =
    /\b(awesome|interview|tutorials?|boilerplates?|starter[\s-]?kits?|cheat[\s-]?sheets?|best[\s-]?practices?|roadmaps?|cookbooks?|handbooks?|study[\s-]?guides?|curated[\s-]?lists?|lists?\s+of)\b/i;

export function looksLikeNonTool(
    meta: {
        fullName: string;
        description?:
            | string
            | null;
    },
): boolean {
    return NON_TOOL_PATTERN.test(
        `${meta.fullName} ${meta.description ?? ""}`,
    );
}

// Step 3: use a reasoning tier to rank and explain the strongest candidates.
async function curate(
    ctx: SourceContext,
    goal: string,
    candidates: RepoMeta[],
    apiKey: string,
): Promise<Recommendation[]> {
    const list = candidates
        .map(
            (c, i) =>
                `${i + 1}. ${c.fullName} | ${c.stars} stars | ${c.language ?? "?"} | updated ${relativeAge(c.pushedAt)} | ${c.description ?? ""}`,
        )
        .join("\n");

    const instructions = [
        "You are a precise engineering advisor. Recommend repos that genuinely complement the project.",
        "Prefer established, widely adopted, actively maintained tools; treat the star count as a signal of",
        "adoption. Treat the last update as a maintenance signal: do not recommend an abandoned or",
        "unmaintained repo (not updated in about two years or more) when a fresher equivalent is in the list.",
        "If the best available option is dated, recommend it but say it is dated in the why.",
        "Recommend the real tool a developer would install, never a tutorial, example, boilerplate,",
        "or list. A popular general-purpose tool usually beats a niche framework-specific wrapper unless the",
        "wrapper is clearly the better fit for this exact stack.",
        "Write in a direct, concrete style. No em dashes. No marketing language.",
    ].join(" ");

    const noun =
        ctx.kind === "website"
            ? "website"
            : "project";

    const user = [
        `The user's ${noun}: ${ctx.fullName}`,
        `What it is: ${ctx.purpose}`,
        `Stack or themes: ${ctx.stack.join(", ")}`,
        `Their goal: "${goal}"`,
        "",
        "Candidate repos:",
        list,
        "",
        `Choose the 3 to 5 best complements. Explain why each fits this ${noun}, how to add it,`,
        "and rate ease and impact from 1 to 5. Use fullName exactly as listed.",
    ].join("\n");

    const text =
        await callOpenAI({
            apiKey,
            model: MODELS.reason,
            instructions,
            input: user,
            maxOutputTokens: 2200,
            reasoningEffort:
                "medium",
            schema: curationFormat,
        });

    const parsed =
        parseStructured<{
            recommendations: {
                fullName: string;
                whatIsIt: string;
                why: string;
                how: string;
                easeOfUse: number;
                impact: number;
            }[];
        }>(text);

    const byName =
        new Map(
            candidates.map((c) => [
                c.fullName.toLowerCase(),
                c,
            ]),
        );

    const out:
        Recommendation[] = [];

    for (
        const r of parsed.recommendations ??
        []
    ) {
        const cand =
            byName.get(
                (
                    r.fullName ?? ""
                ).toLowerCase(),
            );

        if (!cand) {
            continue;
        }

        out.push({
            fullName:
                cand.fullName,
            url: cand.url,
            stars: cand.stars,
            forks: cand.forks,
            language:
                cand.language,
            lastUpdated:
                cand.pushedAt,
            contributors: null,
            velocity90d: null,
            whatIsIt: r.whatIsIt,
            why: r.why,
            how: r.how,
            ratings: {
                easeOfUse: clamp(
                    r.easeOfUse,
                ),
                impact: clamp(
                    r.impact,
                ),
            },
        });
    }

    return out;
}

// Objective metrics straight from GitHub, fetched in parallel for final picks.
async function enrichMetrics(
    recs: Recommendation[],
    token?: string,
): Promise<void> {
    const since =
        new Date(
            Date.now() -
                90 *
                    24 *
                    60 *
                    60 *
                    1000,
        ).toISOString();

    await Promise.all(
        recs.map(async (r) => {
            const [owner, repo] =
                r.fullName.split("/");

            if (!owner || !repo) {
                return;
            }

            const [
                contributors,
                velocity,
            ] = await Promise.all([
                getContributorCount(
                    owner,
                    repo,
                    token,
                ),
                getCommitsSince(
                    owner,
                    repo,
                    since,
                    token,
                ),
            ]);

            r.contributors =
                contributors;

            r.velocity90d =
                velocity;
        }),
    );
}

// Website helpers.
export function looksLikeUrl(
    input: string,
): boolean {
    const s = input.trim();

    if (/^https?:\/\//i.test(s)) {
        return true;
    }

    return /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(
        s,
    );
}

export function normalizeUrl(
    input: string,
): string {
    const s = input.trim();

    const value =
        /^https?:\/\//i.test(s)
            ? s
            : `https://${s}`;

    const url = new URL(value);

    if (
        !/^https?:$/.test(
            url.protocol,
        )
    ) {
        throw new InputError(
            "Only http and https websites are supported.",
        );
    }

    if (
        !isPublicHostname(
            url.hostname,
        )
    ) {
        throw new InputError(
            "Private or local network addresses are not supported.",
        );
    }

    url.username = "";
    url.password = "";
    url.hash = "";

    return url.pathname === "/" &&
        !url.search
        ? url.origin
        : url.toString();
}

async function fetchSite(
    input: string,
): Promise<{
    host: string;
    title: string;
    text: string;
}> {
    const url =
        normalizeUrl(input);

    let res: Response;

    try {
        res =
            await fetchPublicPage(
                url,
            );
    } catch {
        throw new Error(
            "Could not reach that website.",
        );
    }

    if (!res.ok) {
        throw new Error(
            `Could not fetch that website (${res.status}).`,
        );
    }

    const contentType =
        res.headers.get(
            "content-type",
        ) || "";

    if (
        !contentType
            .toLowerCase()
            .includes("text/html")
    ) {
        throw new Error(
            "That address did not return an HTML page.",
        );
    }

    const html =
        await res.text();

    const title =
        (
            html.match(
                /<title[^>]*>([^<]*)<\/title>/i,
            )?.[1] ?? ""
        ).trim();

    const desc =
        (
            html.match(
                /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
            )?.[1] ?? ""
        ).trim();

    const body =
        htmlToText(html);

    const text = [
        desc,
        body,
    ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 5000);

    return {
        host: new URL(url).host.replace(
            /^www\./,
            "",
        ),
        title,
        text,
    };
}

async function fetchPublicPage(
    start: string,
): Promise<Response> {
    let current =
        new URL(start);

    for (
        let redirects = 0;
        redirects <= 3;
        redirects++
    ) {
        if (
            !isPublicHostname(
                current.hostname,
            )
        ) {
            throw new Error(
                "blocked host",
            );
        }

        const response =
            await fetch(
                current.toString(),
                {
                    headers: {
                        "User-Agent":
                            "repofinder (https://repofinder.io)",
                        Accept:
                            "text/html",
                    },
                    redirect:
                        "manual",
                },
            );

        if (
            ![
                301,
                302,
                303,
                307,
                308,
            ].includes(
                response.status,
            )
        ) {
            return response;
        }

        const location =
            response.headers.get(
                "location",
            );

        if (!location) {
            return response;
        }

        current = new URL(
            location,
            current,
        );

        if (
            !/^https?:$/.test(
                current.protocol,
            )
        ) {
            throw new Error(
                "blocked protocol",
            );
        }
    }

    throw new Error(
        "too many redirects",
    );
}

export function isPublicHostname(
    hostname: string,
): boolean {
    const host = hostname
        .toLowerCase()
        .replace(
            /^\[|\]$/g,
            "",
        );

    if (
        host === "localhost" ||
        host.endsWith(
            ".localhost",
        ) ||
        host.endsWith(".local") ||
        host.endsWith(
            ".internal",
        ) ||
        host.includes(":")
    ) {
        return false;
    }

    const match =
        host.match(
            /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
        );

    if (!match) {
        return true;
    }

    const octets = match
        .slice(1)
        .map(Number);

    if (
        octets.some(
            (part) => part > 255,
        )
    ) {
        return false;
    }

    const [a, b] = octets;

    return !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 &&
            b === 254) ||
        (a === 172 &&
            b! >= 16 &&
            b! <= 31) ||
        (a === 192 &&
            b === 168) ||
        a! >= 224
    );
}

export function htmlToText(
    html: string,
): string {
    return html
        .replace(
            /<script[\s\S]*?<\/script>/gi,
            " ",
        )
        .replace(
            /<style[\s\S]*?<\/style>/gi,
            " ",
        )
        .replace(
            /<[^>]+>/g,
            " ",
        )
        .replace(
            /&nbsp;/g,
            " ",
        )
        .replace(
            /&amp;/g,
            "&",
        )
        .replace(
            /&lt;/g,
            "<",
        )
        .replace(
            /&gt;/g,
            ">",
        )
        .replace(
            /\s+/g,
            " ",
        )
        .trim();
}

export function clamp(
    n: number,
): number {
    if (
        typeof n !== "number" ||
        Number.isNaN(n)
    ) {
        return 3;
    }

    return Math.max(
        1,
        Math.min(
            5,
            Math.round(n),
        ),
    );
}

// Human-readable age of the last push, shown to the ranker as a maintenance
// signal so it can avoid recommending abandoned repos.
function relativeAge(
    iso: string | null,
): string {
    if (!iso) {
        return "unknown";
    }

    const days =
        Math.floor(
            (Date.now() -
                new Date(
                    iso,
                ).getTime()) /
                86_400_000,
        );

    if (days < 30) {
        return "this month";
    }

    if (days < 365) {
        return `${Math.floor(days / 30)}mo ago`;
    }

    return `${(days / 365)
        .toFixed(1)
        .replace(
            /\.0$/,
            "",
        )}y ago`;
}