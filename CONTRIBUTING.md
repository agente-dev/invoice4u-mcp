# Contributing

Thanks for considering a contribution to **@agente-dev/invoice4u-mcp**. This is
a public, unofficial integration with Invoice4U. Keep all communications in
**English**.

## Development setup

Requirements: **Node.js 24** or newer, npm.

```bash
npm ci
npm run prepare-once   # installs deps and builds dist/
```

`prepare-once` runs `npm install && npm run build`. There is no `.env` file to
create for development — unit and contract tests use mock clients.

## Test / gate commands

| Command | What it runs |
|---|---|
| `npm run check` | TypeScript typecheck (`tsc --noEmit`) over `src` and `tests` |
| `npm run lint` | Biome lint + formatting check |
| `npm test` | Unit + contract tests (vitest; gated QA integration skips without a token) |
| `npm run build` | Build `dist/` via tsup (ESM, Node 24) |

Run **all four green** before submitting:

```bash
npm run check && npm run lint && npm test && npm run build
```

## Live QA integration

`tests/integration/qa.spec.ts` exercises `verify_connection` +
`list_branches` against the real QA base URL (`INVOICE4U_ENV=qa`) **only when**
`INVOICE4U_API_TOKEN` is set in the environment; otherwise it is skipped and
the suite stays green. It is a read-only smoke test. The full 12-step
acceptance (including writes) requires `INVOICE4U_ALLOW_WRITES=true` in a
throwaway scope and remains blocked until real credentials exist — see
[docs/qa-testing.md](./docs/qa-testing.md).

## Pull request expectations

- **CI must be green.** The `CI` workflow runs lint, typecheck, unit/contract
  tests, build, and an `npm pack --dry-run` verification — all four local gates
  plus the tarball check.
- **English only** in code, comments, docs, commit messages, and PR text.
- **No secrets.** Never commit a real token or `.env` file. Test fixtures and
  docs examples use synthetic data only.
- Follow the existing code style (Biome, 2-space indent, double quotes,
  semicolons). Run `npm run lint` and fix anything it reports.

## Branch naming

Use feature branches off `feat/write-tool` current work, named `feat/*`
(e.g. `feat/docs-and-release`, `feat/something-else`). Do not push directly to
`main`. Open a PR that references the relevant Agente task (e.g. AGC-781) in
the description.

## Documentation

- `docs/`: architecture, tool reference, reconciliation example, QA testing,
  safety, API coverage.
- `coverage-manifest.json`: the machine-readable twin of the tool/operation
  surface. **Keep it in sync** whenever tools, wrapped operations, or excluded
  categories change.
- `README.md` (English) and `README.he.md` (Hebrew mirror) — keep both in sync.