import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/mcp-worker.ts";

describe("MCP worker routing", () => {
  it("returns the expected health payload", async () => {
    const response = await worker.fetch(
      new Request("https://repofinder.example/health"),
      {} as never,
      {} as never,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "repofinder-mcp",
      version: "1.0.0",
    });
  });

  it("advertises the supported endpoints for unknown routes", async () => {
    const response = await worker.fetch(
      new Request("https://repofinder.example/not-found"),
      {} as never,
      {} as never,
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "not found",
      endpoints: {
        health: "/health",
        mcp: "/mcp",
      },
    });
  });
});
