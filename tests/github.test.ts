import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRepo } from "../src/github.ts";

describe("GitHub request fallback", () => {
  it("retries a rejected token once without authentication for a public repository", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Headers[] = [];

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));

      if (calls.length === 1) {
        return new Response("", { status: 401 });
      }

      return Response.json({
        full_name: "owner/repo",
        owner: { login: "owner" },
        name: "repo",
        description: "test repository",
        stargazers_count: 1,
        forks_count: 2,
        language: "TypeScript",
        topics: ["testing"],
        pushed_at: "2026-09-24T00:00:00Z",
        license: { spdx_id: "MIT" },
        archived: false,
        open_issues_count: 0,
        html_url: "https://github.com/owner/repo",
      });
    }) as typeof fetch;

    try {
      const repo = await getRepo("owner", "repo", "stale-token");

      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.get("authorization"), "Bearer stale-token");
      assert.equal(calls[1]?.get("authorization"), null);
      assert.equal(repo.fullName, "owner/repo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("makes an unauthenticated public lookup without adding an authorization header", async () => {
    const originalFetch = globalThis.fetch;
    let requestHeaders = new Headers();

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return Response.json({
        full_name: "owner/repo",
        owner: { login: "owner" },
        name: "repo",
        description: null,
        stargazers_count: 0,
        forks_count: 0,
        language: null,
        topics: [],
        pushed_at: null,
        license: null,
        archived: false,
        open_issues_count: 0,
        html_url: "https://github.com/owner/repo",
      });
    }) as typeof fetch;

    try {
      await getRepo("owner", "repo");
      assert.equal(requestHeaders.get("authorization"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
