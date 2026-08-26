# Invoice4U MCP by Agente

[![CI](https://github.com/agente-dev/invoice4u-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/agente-dev/invoice4u-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agente-dev/invoice4u-mcp.svg)](https://www.npmjs.com/package/@agente-dev/invoice4u-mcp)

An unofficial, third-party [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP-compatible agent safe, typed access to an [Invoice4U](https://invoice4u.co.il) account — searching documents and customers, and creating receipts linked to paid invoices.

- **Unofficial:** this is a community integration, **not affiliated with, endorsed by, or supported by Invoice4U**. Invoice4U names are used nominatively to describe what the server connects to. No Invoice4U trademarks or logos are used without permission.
- **TypeScript / Node.js 24 LTS / MIT** · stdio transport · local self-hosted — Agente never custodies your Invoice4U credentials.
- **Read-only by default:** the single write tool (receipt creation) is not registered in `tools/list` unless `INVOICE4U_ALLOW_WRITES=true`.
- **English [README](./README.md) · Hebrew [README.he.md](./README.he.md)**

## Quick start

```json
{
  "mcpServers": {
    "invoice4u": {
      "command": "npx",
      "args": ["-y", "@agente-dev/invoice4u-mcp"],
      "env": {
        "INVOICE4U_API_TOKEN": "your-api-key",
        "INVOICE4U_ENV": "qa",
        "INVOICE4U_ALLOW_WRITES": "false"
      }
    }
  }
}
```

`INVOICE4U_ENV` must be explicitly `qa` or `production` — it never silently defaults to production. Start against QA; it is the safe documented starting configuration.

## Tools (v0.1 surface)

| Tool | Mode | Purpose |
|---|---|---|
| `invoice4u_verify_connection` | read | Validate token, environment, organization access |
| `invoice4u_search_documents` | read | Search documents: open/closed, dates, customer, type |
| `invoice4u_get_document` | read | Fetch by document ID, document number, or API identifier |
| `invoice4u_search_customers` | read | Search/list customers |
| `invoice4u_get_customer` | read | Complete customer details |
| `invoice4u_list_branches` | read | Organization branches |
| `invoice4u_validate_linked_receipt` | read | Preflight a proposed receipt: documents, balances, allocations, totals — no writes |
| `invoice4u_create_linked_receipt` | write | Create a receipt linked to one or more existing invoices (idempotent via mandatory `apiIdentifier`) |

Read tools declare `readOnlyHint: true, idempotentHint: true`. The write tool declares `readOnlyHint: false, destructiveHint: false, idempotentHint: true` — idempotency holds only because a stable `apiIdentifier` is mandatory and duplicate or uncertain outcomes resolve through identifier lookup. A timeout after submitting a write is never blindly retried: the server first queries by `apiIdentifier` and retries only when the lookup proves no document exists.

Money is expressed as decimal strings at the MCP boundary (`"12500.00"`), never JavaScript floats. Invoice4U responses that return HTTP 200 while carrying application errors in the `Errors` collection are normalized into a typed error model — never reported as success.

## Configuration

Credentials live only in environment variables — the token is never accepted as a tool argument, never returned, never logged.

| Variable | Values | Default |
|---|---|---|
| `INVOICE4U_API_TOKEN` | API key | required |
| `INVOICE4U_ENV` | `qa` or `production` | required — no silent production default |
| `INVOICE4U_ALLOW_WRITES` | `false` or `true` | `false` |
| `INVOICE4U_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |

See [.env.example](./.env.example). Only reviewed official Invoice4U hosts are contacted — there is no arbitrary base-URL escape hatch.

## Safety model

- **Read-only by default** — the write tool is omitted from `tools/list` entirely unless writes are explicitly enabled.
- **Idempotent writes** — mandatory stable `apiIdentifier`; resubmitting the same request cannot create a second receipt.
- **Verified writes** — every write re-fetches the receipt and referenced invoices, returning previous/new balances and statuses as structured output.
- **No blind retries** on uncertain write outcomes; resolution goes through `apiIdentifier` lookup.
- **Secret hygiene** — no tokens or customer PII in logs at normal levels; QA fixtures contain no real customer data.
- **No money movement** — creating a receipt records money already received; the server cannot initiate payments or charge cards.

## Status

**Implemented — v0.1 surface.** Eight tools (7 read + 1 gated write) are implemented and registered as described in the Tools table above. Coverage is tracked in [`coverage-manifest.json`](./coverage-manifest.json), with details in [`docs/`](./docs/).

- **QA status:** read tools are verified against the Invoice4U API reference plus contract tests (120 unit + contract tests green). **Live QA integration is BLOCKED pending credentials** — there is no public Invoice4U sandbox, and exercising `apiqa.invoice4u.co.il` requires a real QA org account + API token. The gated smoke test (`tests/integration/qa.spec.ts`) is skipped without a token; see [`docs/qa-testing.md`](./docs/qa-testing.md).
- **npm package pending:** publication awaits the trusted-publishing link for `@agente-dev/invoice4u-mcp` on npmjs.com.

## License

MIT — see [LICENSE](./LICENSE). © Agente Dev LTD. Not affiliated with Invoice4U.
