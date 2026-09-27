// The shared recommendation engine. This is the ONLY place the recommendation
// logic lives. Both surfaces (the Web API in index.ts and the MCP server in
// mcp.ts) call recommend() and just shape the result.
//
// The input can be a GitHub repo (URL or owner/repo) OR a website URL. Either
// way we produce a SourceContext, run broad GitHub discovery, rank the merged
// candidate pool against the user's full goal and source stack, then optionally
// use OpenAI to curate the final recommendations.

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

type RankableRepo = Pick<
  RepoMeta,
  "fullName" | "description" | "topics" | "stars" | "archived"
> &
  Partial<Pick<RepoMeta, "language" | "pushedAt">>;

const MAX_SEARCH_QUERIES = 6;
const SEARCH_RESULTS_PER_QUERY = 12;
const MAX_CANDIDATES = 12;
const MAX_WEBSITE_BYTES = 2_000_000;

const QUERY_STOP_WORDS = new Set([
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
  "with",
  "and",
  "or",
  "plus",
  "including",
  "using",
  "about",
  "around",
  "as",
  "at",
  "by",
  "from",
  "in",
  "into",
  "on",
  "via",
  "help",
  "helps",
  "helping",
  "useful",
  "capability",
  "capabilities",
  "build",
  "building",
  "built",
  "develop",
  "developing",
  "development",
  "improve",
  "improving",
  "harden",
  "hardening",
  "deploy",
  "deploying",
  "discover",
  "discovers",
  "discovering",
  "rank",
  "ranks",
  "ranking",
]);

const RANK_STOP_WORDS = new Set([
  ...QUERY_STOP_WORDS,
  "from",
  "this",
  "into",
  "use",
  "used",
  "add",
  "adding",
  "build",
  "building",
  "improve",
  "improving",
  "operation",
  "operations",
  "self",
  "website",
]);

const SHORT_TECH_TERMS = new Set(["ai", "ml", "ui", "db", "api", "sdk", "cli", "mcp", "llm", "rpc"]);

const TERM_ALIASES: Record<string, string[]> = {
  authentication: ["auth", "authn", "authorization"],
  authorization: ["auth", "authz", "authentication", "access control"],
  auth: ["authentication", "authorization", "authn", "authz"],
  evaluations: ["evaluation", "eval", "evals"],
  evaluation: ["evaluations", "eval", "evals"],
  evals: ["evaluation", "evaluations", "eval"],
  observability: ["telemetry", "tracing", "monitoring"],
  telemetry: ["observability", "tracing"],
  tracing: ["observability", "telemetry"],
  connectors: ["connector", "integration", "integrations"],
  connector: ["connectors", "integration", "integrations"],
  integrations: ["integration", "connector", "connectors"],
  integration: ["integrations", "connector", "connectors"],
  memory: ["memories"],
  memories: ["memory"],
};

const analysisFormat: JsonSchemaFormat = {
  name: "source_analysis",
  description: "A concise project analysis plus GitHub search queries.",
  schema: {
    type: "object",
    properties: {
      purpose: { type: "string" },
      stack: { type: "array", items: { type: "string" } },
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
            easeOfUse: { type: "integer", minimum: 1, maximum: 5 },
            impact: { type: "integer", minimum: 1, maximum: 5 },
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
  const token = env.GITHUB_TOKEN?.trim() || undefined;

  if (!key) {
    return recommendWithGitHub(input, goal, token);
  }

  try {
    const ctx = await analyzeSource(input, goal, key, token);
    const source = sourceFromContext(ctx);
    const candidates = await gatherCandidates(ctx, goal, token);

    // A model-generated analysis can occasionally produce poor search terms.
    // Retry with the deterministic path rather than returning an empty result.
    if (candidates.length === 0) {
      return recommendWithGitHub(input, goal, token);
    }

    const recommendations = await curate(ctx, goal, candidates, key);

    // Structured output should normally prevent this, but if every model pick is
    // invalid or references a repo outside the candidate set, degrade cleanly.
    if (recommendations.length === 0) {
      const fallback = buildFallbackRecommendations(ctx, goal, candidates);
      await enrichMetrics(fallback, token);
      return {
        source,
        goal,
        mode: "github-fallback",
        recommendations: fallback,
      };
    }

    await enrichMetrics(recommendations, token);
    return { source, goal, mode: "openai", recommendations };
  } catch (error) {
    console.log(
      "OpenAI path failed, using GitHub fallback",
      error instanceof Error ? error.message : String(error),
    );
    return recommendWithGitHub(input, goal, token);
  }
}

async function recommendWithGitHub(
  input: string,
  goal: string,
  token?: string,
): Promise<RecommendResult> {
  const ctx = await buildFallbackContext(input, goal, token);
  const candidates = await gatherCandidates(ctx, goal, token);
  const recommendations = buildFallbackRecommendations(ctx, goal, candidates);

  await enrichMetrics(recommendations, token);

  return {
    source: sourceFromContext(ctx),
    goal,
    mode: "github-fallback",
    recommendations,
  };
}

async function buildFallbackContext(
  input: string,
  goal: string,
  token?: string,
): Promise<SourceContext> {
  const repo = parseRepo(input);

  if (repo) {
    const meta = await getRepo(repo.owner, repo.repo, token);
    return {
      fullName: meta.fullName,
      kind: "repo",
      purpose: meta.description || `The ${meta.fullName} GitHub project.`,
      stack: [meta.language, ...meta.topics.slice(0, 5)].filter(
        (value): value is string => Boolean(value),
      ),
      searchQueries: buildFallbackSearchQueries(goal),
      langHint: meta.language ?? undefined,
      exclude: meta.fullName,
    };
  }

  if (looksLikeUrl(input)) {
    const site = await fetchSite(input);
    return {
      fullName: site.host,
      kind: "website",
      purpose:
        site.title || site.text.slice(0, 180) || `The ${site.host} website.`,
      stack: ["website"],
      searchQueries: buildFallbackSearchQueries(goal),
    };
  }

  throw new InputError(
    "Enter a GitHub repo (URL or owner/repo) or a website URL.",
  );
}

function sourceFromContext(ctx: SourceContext): RecommendResult["source"] {
  return {
    fullName: ctx.fullName,
    kind: ctx.kind,
    purpose: ctx.purpose,
    stack: ctx.stack,
  };
}

function buildFallbackRecommendations(
  ctx: SourceContext,
  goal: string,
  candidates: RepoMeta[],
): Recommendation[] {
  return candidates.slice(0, 5).map((candidate) => ({
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
      `${candidate.fullName} ranked highly for the requested goal using live GitHub metadata, ` +
      `relevance to the goal, source-stack affinity, maintenance state, and adoption signals. ` +
      `Review its API and license against ${ctx.fullName} before integrating it.`,
    how:
      `Review the repository quickstart and integration surface, build a small proof of concept for "${goal}", ` +
      `then validate compatibility with ${ctx.fullName}.`,
    ratings: {
      // Keep the existing fallback scale stable. These are heuristics, not model judgments.
      easeOfUse: candidate.stars >= 10_000 ? 4 : candidate.stars >= 1_000 ? 3 : 2,
      impact: 4,
    },
  }));
}

/**
 * Convert a human goal into a small set of independent GitHub-friendly queries.
 * GitHub repository search ANDs words within a single query, so the discovery
 * stage must prefer several short queries over one natural-language sentence.
 */
export export function buildFallbackSearchQueries(goal: string): string[] {
  const normalized = normalizeGoal(goal);
  if (!normalized) {
    return [];
  }

  const clauses = normalized
    .split(/\s+(?:with|and|or|plus|including|using)\s+|[,;]+/i)
    .map((clause) => cleanQueryWords(clause))
    .filter((words) => words.length > 0);

  const allWords = cleanQueryWords(normalized);
  const queries: string[] = [];
  const seen = new Set<string>();

  const add = (query: string): void => {
    const cleaned = query.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
    if (!cleaned) {
      return;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    queries.push(cleaned);
  };

  // Keep one compact capability phrase per clause. Long natural-language goals
  // often contain intent verbs that make GitHub's AND search too restrictive,
  // so phrases are deliberately short and do not consume the whole query budget.
  if (clauses.length <= 1 && allWords.length <= 4) {
    add(allWords.join(" "));
  } else {
    for (const words of clauses) {
      add(words.slice(0, 3).join(" "));
      if (queries.length >= 3) {
        break;
      }
    }
  }

  // Always reserve room for broad capability terms. This is the safety net for
  // goals such as "build and deploy a TypeScript MCP server on Cloudflare
  // Workers", where a precise multi-word search may have zero GitHub matches
  // even though "mcp", "cloudflare", or "workers" has many useful candidates.
  const broadWords = [...allWords].sort((a, b) => {
    const score = (word: string): number => {
      const lower = word.toLowerCase();
      if (SHORT_TECH_TERMS.has(lower)) return 3;
      if (word.includes("-")) return 2;
      return 1;
    };
    return score(b) - score(a);
  });

  for (const word of broadWords) {
    const lower = word.toLowerCase();
    if (word.includes("-") || SHORT_TECH_TERMS.has(lower) || word.length >= 4) {
      add(word);
    }
    if (queries.length >= MAX_SEARCH_QUERIES) {
      break;
    }
  }

  // If there is still room, add a trailing two-word phrase. This often captures
  // a concrete platform or capability name such as "cloudflare workers".
  if (queries.length < MAX_SEARCH_QUERIES && allWords.length >= 2) {
    add(allWords.slice(-2).join(" "));
  }

  if (queries.length === 0 && allWords.length > 0) {
    add(allWords.slice(0, 4).join(" "));
  }

  return queries.slice(0, MAX_SEARCH_QUERIES);
}

/**
 * Public deterministic ranker retained for tests and callers. gatherCandidates
 * uses the same scorer with extra source-context and multi-query-hit signals.
 */
export function rankFallbackCandidates<T extends RankableRepo>(
  candidates: T[],
  goal: string,
  sourceLanguage?: string,
  sourceThemes: string[] = [],
): T[] {
  return rankCandidates(candidates, goal, sourceLanguage, sourceThemes);
}

function rankCandidates<T extends RankableRepo>(
  candidates: T[],
  goal: string,
  sourceLanguage?: string,
  sourceThemes: string[] = [],
  queryHitCounts?: ReadonlyMap<string, number>,
): T[] {
  const goalTerms = extractRankTerms(buildFallbackSearchQueries(goal));
  const goalPhrases = extractRankPhrases(buildFallbackSearchQueries(goal));
  const sourceLanguageTerms = new Set(
    normalizeMatchText(sourceLanguage ?? "").split(" ").filter(Boolean),
  );
  const sourceTerms = extractRankTerms(sourceThemes).filter(
    (term) => !sourceLanguageTerms.has(term),
  );
  const sourceEcosystem = ecosystemLanguages(sourceLanguage);
  const now = Date.now();

  const score = (candidate: T): number => {
    const name = normalizeMatchText(candidate.fullName);
    const description = normalizeMatchText(candidate.description ?? "");
    const topics = normalizeMatchText(candidate.topics.join(" "));

    // Popularity is useful but deliberately capped so semantic fit dominates.
    let value = Math.min(36, Math.log10(candidate.stars + 1) * 7);
    let matchedGoalConcepts = 0;

    for (const term of goalTerms) {
      const variants = [term, ...(TERM_ALIASES[term] ?? [])];
      const nameMatch = variants.some((variant) => containsNameTerm(name, variant));
      const topicMatch = variants.some((variant) => containsTerm(topics, variant));
      const descriptionMatch = variants.some((variant) =>
        containsTerm(description, variant),
      );

      if (nameMatch) {
        value += 60;
      } else if (topicMatch) {
        value += 42;
      } else if (descriptionMatch) {
        value += 24;
      }

      if (nameMatch || topicMatch || descriptionMatch) {
        matchedGoalConcepts += 1;
      }
    }

    // Exact multi-word capability phrases are stronger than isolated keywords.
    for (const phrase of goalPhrases) {
      if (containsNameTerm(name, phrase)) {
        value += 30;
      } else if (containsTerm(topics, phrase)) {
        value += 24;
      } else if (containsTerm(description, phrase)) {
        value += 16;
      }
    }

    // Reward candidates that cover several parts of a multi-capability request.
    if (matchedGoalConcepts >= 2) {
      value += (matchedGoalConcepts - 1) * 18;
    }

    // Repositories returned by several independent discovery queries are more
    // likely to fit the whole request than a one-keyword false positive.
    const queryHits = queryHitCounts?.get(candidate.fullName.toLowerCase()) ?? 1;
    if (queryHits > 1) {
      value += Math.min(36, (queryHits - 1) * 12);
    }

    // Source-stack affinity is a secondary tie-breaker. It helps a generic goal
    // such as "memory" prefer candidates related to the source project's domain.
    let sourceAffinity = 0;
    for (const term of sourceTerms) {
      if (containsNameTerm(name, term)) {
        sourceAffinity += 10;
      } else if (containsTerm(topics, term)) {
        sourceAffinity += 8;
      } else if (containsTerm(description, term)) {
        sourceAffinity += 4;
      }
    }
    value += Math.min(30, sourceAffinity);

    // Prefer ecosystem-compatible libraries without excluding cross-language
    // services, CLIs or infrastructure that can still be valid complements.
    if (sourceEcosystem && candidate.language) {
      if (sourceEcosystem.has(candidate.language.toLowerCase())) {
        value += 12;
      } else {
        value -= 8;
      }
    }

    if (candidate.pushedAt) {
      const pushed = new Date(candidate.pushedAt).getTime();
      if (Number.isFinite(pushed)) {
        const ageDays = Math.max(0, (now - pushed) / 86_400_000);
        if (ageDays <= 180) {
          value += 8;
        } else if (ageDays >= 1_095) {
          value -= 18;
        } else if (ageDays >= 730) {
          value -= 8;
        }
      }
    }

    if (candidate.archived) {
      value -= 250;
    }

    return value;
  };

  return [...candidates].sort((a, b) => score(b) - score(a));
}

async function analyzeSource(
  input: string,
  goal: string,
  key: string,
  token?: string,
): Promise<SourceContext> {
  const repo = parseRepo(input);

  if (repo) {
    const meta = await getRepo(repo.owner, repo.repo, token);
    const readme = await getReadme(repo.owner, repo.repo, token);
    const analysis = await analyzeRepo(meta, readme, goal, key);

    return {
      ...analysis,
      fullName: meta.fullName,
      kind: "repo",
      langHint: meta.language ?? undefined,
      exclude: meta.fullName,
    };
  }

  if (looksLikeUrl(input)) {
    const site = await fetchSite(input);
    const analysis = await analyzeSite(site, goal, key);
    return { ...analysis, fullName: site.host, kind: "website" };
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
    readme.slice(0, 4000) || "(no README)",
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
  site: { host: string; title: string; text: string },
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
    site.text.slice(0, 4000) || "(no readable content)",
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

function parseAnalysis(text: string): Analysis {
  const parsed = parseStructured<Analysis>(text);

  return {
    purpose: String(parsed.purpose ?? "").trim(),
    stack: Array.isArray(parsed.stack)
      ? parsed.stack.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
      : [],
    searchQueries: Array.isArray(parsed.searchQueries)
      ? parsed.searchQueries
          .map((item) => String(item).trim())
          .filter(Boolean)
          .slice(0, 3)
      : [],
  };
}

async function gatherCandidates(
  ctx: SourceContext,
  goal: string,
  token?: string,
): Promise<RepoMeta[]> {
  const queries: string[] = [];
  const seenQueries = new Set<string>();

  const addQuery = (query: string): void => {
    const cleaned = query.replace(/\s+/g, " ").trim();
    if (!cleaned) {
      return;
    }

    const key = cleaned.toLowerCase();
    if (seenQueries.has(key) || queries.length >= MAX_SEARCH_QUERIES) {
      return;
    }

    seenQueries.add(key);
    queries.push(cleaned);
  };

  // The user's own goal is the authoritative discovery source. This guarantees
  // a model-generated query cannot crowd out deterministic fallback searches.
  const goalQueries = buildFallbackSearchQueries(goal);
  for (const query of goalQueries) {
    addQuery(query);
  }

  // Model-generated or precomputed queries are supplemental. Re-normalize each
  // one so an unexpectedly verbose query cannot recreate the original bug.
  for (const rawQuery of ctx.searchQueries.slice(0, 3)) {
    for (const query of buildFallbackSearchQueries(rawQuery)) {
      addQuery(query);
    }
  }

  // Generic short goals benefit from one or two source-aware variants. These are
  // supplemental rather than restrictive: the broad query remains in the set.
  if (queries.length < MAX_SEARCH_QUERIES && goalQueries.length <= 2) {
    const sourceHints = buildSourceHints(ctx);
    const primary = goalQueries[0];
    if (primary) {
      for (const hint of sourceHints) {
        addQuery(`${primary} ${hint}`);
      }
    }
  }

  // If sanitization stripped everything, retain one bounded form rather than
  // silently making no GitHub requests.
  if (queries.length === 0) {
    const emergency = cleanQueryWords(goal).slice(0, 4).join(" ");
    addQuery(emergency);
  }

  const merged = new Map<string, RepoMeta>();
  const queryHitCounts = new Map<string, number>();

  for (const query of queries) {
    try {
      const hits = await searchRepos(
        query,
        token,
        SEARCH_RESULTS_PER_QUERY,
        ctx.exclude,
      );

      for (const hit of hits) {
        const key = hit.fullName.toLowerCase();
        queryHitCounts.set(key, (queryHitCounts.get(key) ?? 0) + 1);
        if (!merged.has(key)) {
          merged.set(key, hit);
        }
      }
    } catch (error) {
      console.warn(
        `GitHub search failed for "${query}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const pool = [...merged.values()];
  if (pool.length === 0) {
    return [];
  }

  const nonToolsRemoved = pool.filter((repo) => !looksLikeNonTool(repo));
  const usable = nonToolsRemoved.length >= 3 ? nonToolsRemoved : pool;

  const live = usable.filter((repo) => !repo.archived);
  const finalPool = live.length >= 3 ? live : usable;

  return rankCandidates(
    finalPool,
    goal,
    ctx.langHint,
    ctx.stack,
    queryHitCounts,
  ).slice(0, MAX_CANDIDATES);
}

function buildSourceHints(ctx: SourceContext): string[] {
  const sourceLanguage = ctx.langHint?.toLowerCase();
  const hints: string[] = [];
  const seen = new Set<string>();

  for (const item of ctx.stack) {
    for (const query of buildFallbackSearchQueries(item)) {
      const cleaned = query.trim();
      const key = cleaned.toLowerCase();

      if (
        !cleaned ||
        key === "website" ||
        key === sourceLanguage ||
        seen.has(key) ||
        cleaned.split(/\s+/).length > 2
      ) {
        continue;
      }

      seen.add(key);
      hints.push(cleaned);

      if (hints.length >= 2) {
        return hints;
      }
    }
  }

  return hints;
}

/**
 * Languages whose libraries can usually be adopted in the same code ecosystem.
 * This is now used as a ranking preference rather than a hard discovery filter,
 * because valid complements can also be services, CLIs or infrastructure.
 */
export function ecosystemLanguages(lang?: string | null): Set<string> | null {
  if (!lang) {
    return null;
  }

  const normalized = lang.toLowerCase();
  const groups: string[][] = [
    ["typescript", "javascript"],
    ["python"],
    ["go"],
    ["rust"],
    ["ruby"],
    ["java", "kotlin", "scala"],
    ["c#", "f#"],
    ["php"],
    ["c++", "c"],
    ["swift", "objective-c"],
    ["elixir", "erlang"],
    ["dart"],
  ];

  const group = groups.find((candidate) => candidate.includes(normalized));
  return new Set(group ?? [normalized]);
}

const NON_TOOL_PATTERN =
  /\b(awesome|interview|tutorials?|boilerplates?|starter[\s-]?kits?|cheat[\s-]?sheets?|best[\s-]?practices?|roadmaps?|cookbooks?|handbooks?|study[\s-]?guides?|curated[\s-]?lists?|lists?\s+of)\b/i;

export function looksLikeNonTool(meta: {
  fullName: string;
  description?: string | null;
}): boolean {
  return NON_TOOL_PATTERN.test(`${meta.fullName} ${meta.description ?? ""}`);
}

async function curate(
  ctx: SourceContext,
  goal: string,
  candidates: RepoMeta[],
  apiKey: string,
): Promise<Recommendation[]> {
  const list = candidates
    .map(
      (candidate, index) =>
        `${index + 1}. ${candidate.fullName} | ${candidate.stars} stars | ${
          candidate.language ?? "?"
        } | updated ${relativeAge(candidate.pushedAt)} | ${
          candidate.description ?? ""
        }`,
    )
    .join("\n");

  const instructions = [
    "You are a precise engineering advisor. Recommend repositories that genuinely complement the project.",
    "Prioritize direct capability fit first, then maintenance, adoption, and practical integration fit.",
    "Do not choose a repository merely because one generic word in its description matches the goal.",
    "Prefer actively maintained tools; avoid archived or abandoned options when a fresher equivalent is available.",
    "Recommend the real tool a developer would install or integrate, never a tutorial, example, boilerplate, or curated list.",
    "Only choose repositories from the supplied candidate list and use fullName exactly as listed.",
    "Write in a direct, concrete style. No em dashes. No marketing language.",
  ].join(" ");

  const noun = ctx.kind === "website" ? "website" : "project";
  const user = [
    `The user's ${noun}: ${ctx.fullName}`,
    `What it is: ${ctx.purpose}`,
    `Stack or themes: ${ctx.stack.join(", ") || "(unknown)"}`,
    `Their goal: "${goal}"`,
    "",
    "Candidate repositories:",
    list,
    "",
    `Choose the 3 to 5 strongest complements. Explain why each fits this ${noun}, how to add it,`,
    "and rate ease and impact from 1 to 5. Use fullName exactly as listed.",
  ].join("\n");

  const text = await callOpenAI({
    apiKey,
    model: MODELS.reason,
    instructions,
    input: user,
    maxOutputTokens: 2200,
    reasoningEffort: "medium",
    schema: curationFormat,
  });

  const parsed = parseStructured<{
    recommendations: {
      fullName: string;
      whatIsIt: string;
      why: string;
      how: string;
      easeOfUse: number;
      impact: number;
    }[];
  }>(text);

  const byName = new Map(
    candidates.map((candidate) => [candidate.fullName.toLowerCase(), candidate]),
  );
  const seen = new Set<string>();
  const out: Recommendation[] = [];

  for (const item of parsed.recommendations ?? []) {
    const key = String(item.fullName ?? "").toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    const candidate = byName.get(key);
    if (!candidate) {
      continue;
    }

    seen.add(key);
    out.push({
      fullName: candidate.fullName,
      url: candidate.url,
      stars: candidate.stars,
      forks: candidate.forks,
      language: candidate.language,
      lastUpdated: candidate.pushedAt,
      contributors: null,
      velocity90d: null,
      whatIsIt: String(item.whatIsIt ?? "").trim() || candidate.description || candidate.fullName,
      why: String(item.why ?? "").trim(),
      how: String(item.how ?? "").trim(),
      ratings: {
        easeOfUse: clamp(item.easeOfUse),
        impact: clamp(item.impact),
      },
    });
  }

  return out.slice(0, 5);
}

async function enrichMetrics(
  recommendations: Recommendation[],
  token?: string,
): Promise<void> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  await Promise.all(
    recommendations.map(async (recommendation) => {
      const [owner, repo] = recommendation.fullName.split("/");
      if (!owner || !repo) {
        return;
      }

      const [contributors, velocity] = await Promise.all([
        getContributorCount(owner, repo, token),
        getCommitsSince(owner, repo, since, token),
      ]);

      recommendation.contributors = contributors;
      recommendation.velocity90d = velocity;
    }),
  );
}

function normalizeGoal(value: string): string {
  return value
    .replace(/[_/]+/g, " ")
    .replace(/[^\w\s+#.,;-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQueryWords(value: string): string[] {
  return value
    .replace(/[^\w\s+#.-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => /[a-z0-9+#]/i.test(word))
    .filter((word) => !QUERY_STOP_WORDS.has(word.toLowerCase()));
}

function extractRankTerms(values: string[]): string[] {
  const terms = new Set<string>();

  for (const value of values) {
    const normalized = normalizeMatchText(value);
    for (const term of normalized.split(" ")) {
      if (!term || RANK_STOP_WORDS.has(term)) {
        continue;
      }
      if (term.length >= 3 || SHORT_TECH_TERMS.has(term)) {
        terms.add(term);
      }
    }
  }

  return [...terms].slice(0, 20);
}

function extractRankPhrases(values: string[]): string[] {
  const phrases = new Set<string>();

  for (const value of values) {
    const phrase = normalizeMatchText(value)
      .split(" ")
      .filter((term) => term && !RANK_STOP_WORDS.has(term))
      .join(" ")
      .trim();

    if (phrase.split(" ").filter(Boolean).length >= 2) {
      phrases.add(phrase);
    }
  }

  return [...phrases].slice(0, 8);
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(normalizedText: string, term: string): boolean {
  const normalizedTerm = normalizeMatchText(term);
  if (!normalizedText || !normalizedTerm) {
    return false;
  }

  return ` ${normalizedText} `.includes(` ${normalizedTerm} `);
}

function containsNameTerm(normalizedName: string, term: string): boolean {
  if (containsTerm(normalizedName, term)) {
    return true;
  }

  const compactName = normalizedName.replace(/\s+/g, "");
  const compactTerm = normalizeMatchText(term).replace(/\s+/g, "");
  return compactTerm.length >= 4 && compactName.includes(compactTerm);
}

// Website helpers.
export function looksLikeUrl(input: string): boolean {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    return true;
  }
  return /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value);
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const value = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(value);

  if (!/^https?:$/.test(url.protocol)) {
    throw new InputError("Only http and https websites are supported.");
  }

  if (!isPublicHostname(url.hostname)) {
    throw new InputError("Private or local network addresses are not supported.");
  }

  url.username = "";
  url.password = "";
  url.hash = "";

  return url.pathname === "/" && !url.search ? url.origin : url.toString();
}

async function fetchSite(
  input: string,
): Promise<{ host: string; title: string; text: string }> {
  const url = normalizeUrl(input);
  let response: Response;

  try {
    response = await fetchPublicPage(url);
  } catch {
    throw new Error("Could not reach that website.");
  }

  if (!response.ok) {
    throw new Error(`Could not fetch that website (${response.status}).`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error("That address did not return an HTML page.");
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBSITE_BYTES) {
    throw new Error("That website page is too large to analyze safely.");
  }

  const html = await response.text();
  if (html.length > MAX_WEBSITE_BYTES) {
    throw new Error("That website page is too large to analyze safely.");
  }

  const title = decodeBasicEntities(
    (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim(),
  );
  const description = extractMetaDescription(html);
  const body = htmlToText(html);
  const text = [description, body].filter(Boolean).join("\n").slice(0, 5000);

  return {
    host: new URL(url).host.replace(/^www\./, ""),
    title,
    text,
  };
}

async function fetchPublicPage(start: string): Promise<Response> {
  let current = new URL(start);

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isPublicHostname(current.hostname)) {
      throw new Error("blocked host");
    }

    const response = await fetch(current.toString(), {
      headers: {
        "User-Agent": "repofinder (https://repofinder.io)",
        Accept: "text/html",
      },
      redirect: "manual",
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    current = new URL(location, current);
    if (!/^https?:$/.test(current.protocol)) {
      throw new Error("blocked protocol");
    }
  }

  throw new Error("too many redirects");
}

export function isPublicHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":")
  ) {
    return false;
  }

  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return true;
  }

  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part > 255)) {
    return false;
  }

  const [a, b, c] = octets;

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

function extractMetaDescription(html: string): string {
  const nameThenContent = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i,
  )?.[1];
  const contentThenName = html.match(
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i,
  )?.[1];

  return decodeBasicEntities((nameThenContent ?? contentThenName ?? "").trim());
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function htmlToText(html: string): string {
  return decodeBasicEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function clamp(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) {
    return 3;
  }
  return Math.max(1, Math.min(5, Math.round(n)));
}

function relativeAge(iso: string | null): string {
  if (!iso) {
    return "unknown";
  }

  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days < 30) {
    return "this month";
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}mo ago`;
  }
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y ago`;
}
