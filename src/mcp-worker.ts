import { handleMcpRequest } from "./mcp";
import type { EngineEnv } from "./engine";

export interface Env extends EngineEnv {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({
        ok: true,
        service: "repofinder-mcp",
        version: "1.0.0",
      });
    }

    if (url.pathname === "/mcp") {
      return handleMcpRequest(request, env, ctx);
    }

    return Response.json(
      {
        error: "not found",
        endpoints: {
          health: "/health",
          mcp: "/mcp",
        },
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
