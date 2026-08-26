# Invoice4U MCP — QA Acceptance (AGC-781, 12-step checklist)

**Status: BLOCKED — pending credentials.**

Coverage-manifest state for every tool is `blocked_pending_credentials`. Live
QA integration cannot run until an Invoice4U organization account with API access
enabled is provided.

## Why it is blocked

- The QA environment **`apiqa.invoice4u.co.il`** requires a real Invoice4U
  org account with API access enabled and its API token. **There is no public
  sandbox** — you cannot sign up anonymously to exercise the API. Credentials
  for QA must come from a maintainer with an Invoice4U account.
- The 12-step acceptance, especially the write steps, must run against a
  **throwaway QA org** where creating/receipting data has no consequence.

## Prerequisites

- A QA Invoice4U org account with API access enabled, and its API token.
- Run the server with:
  - `INVOICE4U_ENV=qa`
  - `INVOICE4U_API_TOKEN=<qa token>` (throwaway scope)
  - `INVOICE4U_ALLOW_WRITES=true` (for steps 11–12; keep this in a throwaway
    scope so accidental writes are harmless)
  - `INVOICE4U_LOG_LEVEL=info` (or `debug` for troubleshooting)
- Optional automation: a **thin gated integration runner**,
  [`tests/integration/qa.spec.ts`](../tests/integration/qa.spec.ts), is gated by
  `describe.skipIf(!process.env.INVOICE4U_API_TOKEN)` and exercises
  `invoice4u_verify_connection` + `invoice4u_list_branches` against the real QA
  base URL when the token is present (see the CI section below).

## The 12-step acceptance sequence

Each step maps to a concrete tool call and states **what it proves**.

| # | Step | Tool(s) | Proves |
|---|---|---|---|
| 1 | **Auth sanity** — verify the token against QA | `invoice4u_verify_connection` | Token valid; correct `environment` (`qa`); org identity returned (user id/email, orgId). |
| 2 | **Branch listing** | `invoice4u_list_branches` | Branch query works; default/main branches present; null-result→`authentication_failed` handling is sound. |
| 3 | **Customer search** | `invoice4u_search_customers` | Filtered customer search returns seeded customers; `count` and `limit` behave. |
| 4 | **Customer detail** | `invoice4u_get_customer` | Full-customer normalization (bank/contacts) for a known customer ID. |
| 5 | **Document search — open** | `invoice4u_search_documents` (`documentType=invoice`, `status=open`) | Seeded open invoices are found; date/customer/type filters work end-to-end. |
| 6 | **Document get by ID** | `invoice4u_get_document` (`documentId`) | Fetch-by-GUID works; normalized document shape is correct. |
| 7 | **Document get by number** | `invoice4u_get_document` (`documentNumber` + `documentType`) | Sequential-number lookup works (per type). |
| 8 | **Document get by apiIdentifier** | `invoice4u_get_document` (`apiIdentifier`) | Idempotency-key lookup path works; documents expose `apiIdentifier`. |
| 9 | **Read-only preflight** | `invoice4u_validate_linked_receipt` | On a known open invoice with a known balance, the preflight reports `valid: true` with correct balances/totals. |
| 10 | **Preflight rejects invalid allocation** | `invoice4u_validate_linked_receipt` (allocation > balance, and/or payments ≠ allocations) | Over-allocation → `allocation_exceeds_balance`; mismatch → `invoice4u_validation_error`; not-open → `invoice_not_open`. Proven it never writes. |
| 11 | **Write — create linked receipt** | `invoice4u_create_linked_receipt` (writes enabled) | A receipt is created (`status: created`) with `verification.balancesConsistent: true`; post-state balances drop correctly. Uses a unique throwaway `apiIdentifier`. |
| 12 | **Write — idempotent replay** | `invoice4u_create_linked_receipt` (same `apiIdentifier`) | Replaying the identical call returns `status: already_exists`, no duplicate is created, and balances are unchanged — confirming the API **134 idempotent-success** contract. |

Steps 1–8 are **read-only** and can be run against any QA org with data. Steps
9–10 are read-only preflights. Steps **11–12 are writes** and require
`INVOICE4U_ALLOW_WRITES=true` in a **throwaway** scope.

## How secrets reach CI

- Secrets are **never committed**. The only secret is the QA API token, provided
  via GitHub Actions secret **`INVOICE4U_API_TOKEN`**.
- The `qa-integration` workflow (`.github/workflows/qa-integration.yml`) is
  `workflow_dispatch` + a weekly `schedule`. Its first (guard) job checks whether
  the secret is configured:
  - **missing** → the job is skipped with an explanatory notice (not a failure);
    tests still pass because the gated runner `describe.skipIf`s to zero tests.
  - **present** → sets `INVOICE4U_API_TOKEN` from the secret, `INVOICE4U_ENV=qa`,
    and runs the gated `tests/integration/qa.spec.ts` via vitest.
- The GitHub Actions workflow `env` is the **only** place the token reaches CI.
  Local `.env`, `.env.*`, and `dist/` are gitignored (see `.gitignore`). The
  token is sent to the API in the request body only, and redacted from any error
  message before it escapes (see `docs/safety.md`).

## Running the gated smoke test locally

When you have a QA token, run:

```bash
INVOICE4U_API_TOKEN=<qa-token> INVOICE4U_ENV=qa npm test
```

`tests/integration/qa.spec.ts` only then exercises `verify_connection` and
`list_branches` against `apiqa.invoice4u.co.il`. Without the variable the suite
is skipped: `npm test` stays green at 120 tests.