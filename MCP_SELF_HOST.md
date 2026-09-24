# Self-host the RepoFinder MCP worker

This fork includes a minimal Cloudflare Worker deployment specifically for ChatGPT MCP use. It is separate from the original RepoFinder website deployment and does not require the original author's D1 database, custom domain, telemetry, contact form, Telegram integration, or rate-limit namespace IDs.

## First deployment

The first test should use **no secrets**. RepoFinder can read public GitHub repositories without a token and will use its GitHub-only fallback when no OpenAI API key is configured.

From a machine with Node.js installed:

```bash
npm install
npx wrangler login
npm run deploy:mcp
```

Cloudflare will return a URL similar to:

```text
https://repofinder-mcp.<your-workers-subdomain>.workers.dev
```

Check:

```text
https://repofinder-mcp.<your-workers-subdomain>.workers.dev/health
```

It should return JSON containing `"ok": true`.

Then create the ChatGPT custom MCP app using:

```text
https://repofinder-mcp.<your-workers-subdomain>.workers.dev/mcp
```

Use no authentication for this first read-only test.

## Optional GitHub token

After the unauthenticated test works, add a read-only GitHub token to increase GitHub API limits:

```bash
npx wrangler secret put GITHUB_TOKEN --config wrangler.mcp.jsonc
```

A rejected token no longer takes down public-repository lookups: the fork retries a 401 once without authentication.

## Optional OpenAI ranking

To enable the model-ranked recommendation path:

```bash
npx wrangler secret put OPENAI_API_KEY --config wrangler.mcp.jsonc
```

Without this secret, the service intentionally uses RepoFinder's deterministic GitHub fallback.

## Cloudflare dashboard / Git integration

If deploying from the Cloudflare dashboard instead of the CLI, connect this GitHub repository and set the deploy command to:

```bash
npm run deploy:mcp
```

No D1 database, custom domain, or other Cloudflare resource is required for the MCP-only worker.

## Security note

This first deployment is a public, read-only MCP endpoint intended to prove the ChatGPT → custom MCP → GitHub path. Before adding write-capable tools or private data sources, add proper authentication and a permission boundary rather than extending the no-auth deployment.

## Operations

For the normal merge/deploy path, production health checks, dependency-update procedure, and emergency rollback commands, see [MCP_OPERATIONS.md](./MCP_OPERATIONS.md).
