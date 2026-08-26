# Invoice4U MCP — Safety (AGC-781, Train E)

This document is the threat model for the server. Every design choice in
`docs/architecture.md` and the tool surface is traceable to a threat below.

## 1. Credential handling

- **Environment-only:** the API token is read exclusively from
  `INVOICE4U_API_TOKEN`. It is **never** accepted as a tool argument, never
  returned in any tool output, and never written to logs.
- **Redaction:** the client redacts the token from any thrown error message
  before it escapes (`Invoice4uErrorImpl.redact`). A token can never appear in
  a message surfaced to an MCP client or a log line.
- **`.gitignore`:** `.env`, `.env.*`, `dist/`, and `coverage/` are ignored; only
  `.env.example` is committed (no real values). GitHub Actions secrets supply the
  token in CI; it never lives in the tree.
- **Transport:** the token travels in the HTTPS request body only — never in a
  URL or a query string.

## 2. Write gating is default-off

- Writing is disabled unless `INVOICE4U_ALLOW_WRITES=true`.
- When disabled, the write tool is **not registered at all** — it is absent from
  `tools/list`, so an agent literally cannot call it. This is structural, not an
  advisory flag an agent could ignore.

## 3. Idempotency contract

- **Mandatory stable `apiIdentifier`** on the write tool; a duplicate returns the
  existing receipt (`already_exists`) instead of creating a second document.
- Because the key is unique-per-document and stable, a retried/replayed call
  cannot double-post a receipt. API code **134** (duplicate identifier) is
  interpreted at the tool level as idempotent success.
- Idempotency is **only** as good as the caller's `apiIdentifier` generation:
  callers must derive the key from the source record (see
  `docs/reconciliation-example.md`).

## 4. No money movement

- Creating a receipt **records money already received** — it allocates an
  existing deposit across open invoices. The server **cannot** initiate a
  payment, charge a stored card, or move money. This is the single
  highest-severity threat and it is structurally excluded: the write surface is
  exactly one idempotent, receipt-only operation.
- Match/cancel/charge/standing-order operations (any that could initiate or move
  money) are deliberately **not** wrapped (see `docs/api-coverage.md`).

## 5. No blind retries

- **The client never auto-retries writes.** A transient failure after submit is
  resolved by looking the receipt up by `apiIdentifier`; the create is retried
  **only** when that lookup proves no document exists (see the 10-step flow in
  `docs/architecture.md`).
- Reads retry only on `network_error` (max 2, exponential backoff). No other
  kind is retried.

## 6. Host allowlist

- The base URL is **always** derived from the two-entry allowlist
  (qa / production) via `resolveBaseUrl(env)`. There is no arbitrary base-URL
  override, so credentials can never be exfiltrated to an untrusted host by
  configuration or a crafted argument.

## 7. PII / log hygiene

- Tokens and customer **PII** (names, emails, phone numbers, bank details) are
  not logged at normal levels. `debug` logs redacted request/response metadata
  only — never full customer payloads.
- QA fixtures and all examples in these docs use **synthetic** data; no real
  customer records appear anywhere in the repository.

## 8. Decimal money rationale

- Money is a **decimal string** at the MCP boundary and **integer minor units**
  internally (`docs/architecture.md`). No float arithmetic is performed on any
  monetary value. Floats (`0.1 + 0.2 !== 0.3`) would silently produce wrong
  allocations and balances — precisely what a reconciliation tool must not do.
- Integer minor-unit arithmetic is exact within ±2^53−1 minor units, far beyond
  any realistic invoice total. The only sanctioned API conversion is
  `floatFromApi` (string round-trip to 2dp).

## 9. Verification as the last line of defense

- Every write re-fetches the receipt and referenced invoices and returns
  `verification.balancesConsistent`. A write whose post-state cannot be verified
  is reported `verification_failed`, not success — a failure of certainty is
  surfaced, never papered over.