// Stateless MCP server over Streamable HTTP. It exposes the same recommendation
// engine as the browser API without duplicating recommendation logic.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { recommend, type EngineEnv } from "./engine";

function createRepoFinderServer(env: EngineEnv): McpServer {
  const server = new McpServer({ name: "repofinder", version: "1.0.0" });
  server.registerTool(
    "recommend_repos",
    {
      description:
        "Given a GitHub repo (URL or owner/repo) or a website URL plus a goal, return GitHub " +
        "repos that complement it. Each result includes what it is, why it fits, how to integrate " +
        "it, ease and impact ratings, and objective maintenance metrics.",
      inputSchema: {
        repoOrUrl: z.string().min(1).max(500),
        goal: z.string().min(1).max(300),
      },
    },
    async ({ repoOrUrl, goal }) => {
      const result = await recommend(repoOrUrl, goal, env);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
  return server;
}

export function handleMcpRequest(request: Request, env: EngineEnv, ctx: ExecutionContext): Promise<Response> {
  // Allow the hostname Cloudflare actually assigned to this deployment. This
  // keeps the MCP handler compatible with workers.dev now and a custom domain
  // later, without hard-coding the original author's repofinder.io hostname.
  const requestHost = new URL(request.url).hostname;
  const localHosts = ["localhost", "127.0.0.1", "[::1]"];

  const handler = createMcpHandler(() => createRepoFinderServer(env), {
    route: "/mcp",
    legacy: "stateless",
    allowedHostnames: [requestHost, ...localHosts],
    allowedOriginHostnames: [requestHost, "chatgpt.com", "chat.openai.com", ...localHosts],
    corsOptions: { origin: "*" },
  });
  return handler(request, env, ctx);
}
