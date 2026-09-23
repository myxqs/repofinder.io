// The shared recommendation engine. This is the ONLY place the recommendation
// logic lives. Both surfaces (the Web API in index.ts and the MCP server in
// mcp.ts) call recommend() and just shape the result.
//
// The input can be a GitHub repo (URL or owner/repo) OR a website URL. Either
// way we produce an Analysis (purpose, stack, search queries), then run the same
// GitHub search and ranking. Recommendations are always GitHub repos.
import { parseRepo, getRepo, getReadme, searchRepos, getContributorCount, getCommitsSince, type RepoMeta, } from "./github";
import { callOpenAI, parseStructured, MODELS, type JsonSchemaFormat } from "./openai";
export interface EngineEnv {
    OPENAI_API_KEY?: string;
    GITHUB_TOKEN?: string;
}
export class InputError extends Error {
}
export interface Recommendation {
    fullName: string;
    url: string;
    stars: number;
    forks: number;
    language: string | null;
    lastUpdated: string | null; // ISO date of last push
    contributors: number | null; // null when GitHub did not return it
    velocity90d: number | null; // commits in the last 90 days
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
            stack: { type: "array", items: { type: "string" } },
            searchQueries: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } },
        },
        required: ["purpose", "stack", "searchQueries"],
        additionalProperties: false,
    },
};
const curationFormat: JsonSchemaFormat = {
    name: "repo_recommendations",
    description: "The best complementary repositories and project-specific integration guidance.",
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
                    required: ["fullName", "whatIsIt", "why", "how", "easeOfUse", "impact"],
                    additionalProperties: false,
                },
            },
        },
        required: ["recommendations"],
        additionalProperties: false,
    },