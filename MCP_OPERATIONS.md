# RepoFinder MCP operations

This runbook covers the self-hosted Cloudflare Worker defined by `wrangler.mcp.jsonc`.

## Production service

Worker: `repofinder-mcp`

Health endpoint:

```text
https://repofinder-mcp.theroach.workers.dev/health
```

A healthy response contains:

```json
{"ok":true,"service":"repofinder-mcp","version":"1.0.0"}
```

## Normal change path

1. Open a pull request against `main`.
2. Let the required `check` job validate dependencies, Wrangler generated types, both Worker bundles, TypeScript, and tests.
3. Review CodeQL results.
4. Merge only after the required checks pass.
5. The Cloudflare Git integration deploys `repofinder-mcp` from `main` using:

```bash
npm run deploy:mcp
```

6. Confirm the Cloudflare `Workers Builds: repofinder-mcp` check succeeds.
7. Confirm the `production smoke` workflow succeeds against the live health endpoint.

Do not manually redeploy a failed commit simply to make a check green. Fix or revert the repository state first unless an emergency rollback is required.

## Local preflight

Use the repository's locked dependencies and local Wrangler installation:

```bash
npm ci
npm audit --audit-level=high
npx wrangler types --check --config wrangler.jsonc
npx wrangler deploy --dry-run --outdir .wrangler-ci/site
npx wrangler deploy --config wrangler.mcp.jsonc --dry-run --outdir .wrangler-ci/mcp
npm run check
```

If `wrangler types --check` reports drift after a Wrangler/runtime update, regenerate and review the declaration file before merging:

```bash
npx wrangler types --config wrangler.jsonc
```

## Dependency updates

Dependabot is configured in `.github/dependabot.yml`.

- npm security updates are grouped into one security PR where possible.
- routine npm minor/patch version updates are grouped weekly.
- npm major updates remain separate for deliberate review.
- GitHub Actions updates are grouped weekly.
- high-severity npm audit findings fail the required CI check.

For dependency-only PRs, avoid merging overlapping updates. Prefer the PR that produces the complete intended dependency state, validate it once, merge once, and close the narrower PR as superseded.

## Rollback

Cloudflare Workers keeps version and deployment history. Inspect the current deployment and recent versions with:

```bash
npx wrangler deployments list --config wrangler.mcp.jsonc
npx wrangler versions list --config wrangler.mcp.jsonc
```

For an emergency rollback, prefer an explicit known-good version ID:

```bash
npx wrangler rollback <VERSION_ID> --config wrangler.mcp.jsonc --message "Rollback after failed deployment"
```

After rollback, verify:

```text
https://repofinder-mcp.theroach.workers.dev/health
```

A Worker rollback restores Worker code/configuration for the selected version. It does not restore external storage state. Re-check bindings before rolling back if the MCP Worker later gains D1, KV, R2, Durable Objects, queues, or other stateful resources.

## Security boundary

The current MCP deployment is intentionally public and read-only.

- `GITHUB_TOKEN` is optional and should remain read-only.
- A rejected GitHub token falls back once to an unauthenticated public-repository request.
- Without `OPENAI_API_KEY`, recommendations use the deterministic GitHub fallback.
- Do not add write-capable tools or private data sources to the public endpoint without authentication and an explicit permission boundary.
