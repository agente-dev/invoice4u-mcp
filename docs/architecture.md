# Invoice4U MCP — Architecture (AGC-781, Train E)

This document describes the modules, data flows, error model, money model,
host allowlist, and the key design decisions behind the
`@agente-dev/invoice4u-mcp` server.

## Layout

```
src/
  index.ts                             Entry: loadConfig → build client·server → connect stdio
  server.ts                            MCP wiring: registerReadTools + registerWriteTools
  config.ts                            Environment config (token, env, allowWrites, log level, base URL)
  invoice4u/
    client.ts                          The only way to talk to the Invoice4U HTTP API
    errors.ts                          Typed 9-kind Invoice4uError model + code→kind mapping
    money.ts                           Decimal-string money (integer minor units, no float math)
    schemas.ts                         Zod schemas for every MCP-facing input
    types.ts                           Typed wire types for the Invoice4U API
  tools/
    support.ts                         Shared tool plumbing (annotations, guardedRead, errors)
    verifyConnection.ts                invoice4u_verify_connection
    searchDocuments.ts                 invoice4u_search_documents
    getDocument.ts                     invoice4u_get_document
    searchCustomers.ts                 invoice4u_search_customers
    getCustomer.ts                     invoice4u_get_customer
    listBranches.ts                    invoice4u_list_branches
    validateLinkedReceipt.ts           invoice4u_validate_linked_receipt (read-only preflight)
    createLinkedReceipt.ts             invoice4u_create_linked_receipt (the one write tool)
    mappings.ts                        enum/code mapping helpers
tests/
  unit/ …                              Unit tests (config, errors, money)
  contract/ …                          Contract tests through the real MCP path with a mock client
  integration/qa.spec.ts               Gated live-QA integration test (skipped without a token)
```

## Module map

**config → client → tools → server/index**

- `src/index.ts` loads configuration, constructs an `Invoice4uClient`,
  creates an `McpServer`, registers tools, and connects the `StdioServerTransport`.
- `src/config.ts` (`loadConfig`) validates environment variables and resolves the
  allowlisted base URL **from `env` only** — there is no URL override.
- `src/invoice4u/*` are the transport and domain layers — typed client calls,
  the error model, decimal-money arithmetic, input schemas, and wire types.
  They know nothing about MCP.
- `src/tools/*` are thin, typed MCP tool handlers. Each takes `ToolDeps`
  (`{ client, config }`), validates input via a zod schema, calls the client,
  and returns an `{ content, structuredContent }` `CallToolResult`.
- `src/server.ts` is the only place tools are registered on the MCP server and
  the only place annotations are attached.

`index.ts` never talks to the API directly; `server.ts` never performs I/O
itself. Each layer depends only on the layer below it.

## Data flow — reads

1. MCP `tools/call` arrives for a read tool; the SDK validates `arguments`
   against the tool's zod input schema.
2. The tool handler (`guardedRead`) runs; it parses/normalizes the input,
   then calls the typed client method(s).
3. `Invoice4uClient.call` wraps a single HTTP attempt: it POSTs
   `{ ...params, token }` as JSON to `${baseUrl}/${op}`, unwraps the
   `<Op>Result` envelope, and checks the `Errors` array **on every response**.
4. A non-empty `Errors` array (even on HTTP 200) is normalized into a typed
   `Invoice4uError` via the code→kind map — never treated as success.
5. On success the handler builds a short human `text` plus `structuredContent`
   and returns; on an expected failure `guardedRead` returns an
   `isError: true` result carrying `{ error: { kind, message, retryable, … } }`.
6. Unexpected errors (bugs, protocol misuse) are rethrown so the MCP SDK wraps
   them in its internal-error result.

Reads are declared `readOnlyHint: true, idempotentHint: true` and never call a
client write method. Reads that hit a transient `network_error` are retried up
to twice by the client with exponential backoff.

## The write safety flow (10 steps) — `invoice4u_create_linked_receipt`

The write tool executes a fixed ten-step flow. **Nothing is submitted until
every preflight check passes.** Steps 1–6 are read/schema checks; step 7 is the
single HTTP create; steps 8–10 recover and verify.

1. **Schema** — SDK-validated input is exactly `createLinkedReceiptInput`
   (`apiIdentifier`, `clientId`, `paymentDate`, `payments[1..]`,
   `invoiceAllocations[1..]`, optional `subject`/`remarks`).
2. **Idempotency key** — `apiIdentifier` is present/non-empty (enforced by the
   schema). It is the idempotency key, so it is mandatory.
3. **Fetch every referenced invoice** via `getDocument` (deduplicated). Any
   missing invoice → `document_not_found` with the offending IDs.
4. **Every referenced invoice must be open** (StatusID 1) — otherwise
   `invoice_not_open` (offenders listed).
5. **Each allocation ≤ the invoice's open balance** — otherwise
   `allocation_exceeds_balance` (per invoice, `{ allocation, balance }`).
6. **`Σpayments === Σallocations` exactly** (minor-unit arithmetic) — otherwise
   `invoice4u_validation_error` with both totals.
7. **Build and submit** the `CreateReceiptDoc`
   (`DocumentType` 2, `ClientID`, mapped `PaymentType`s, float amounts at the
   boundary, `Invoices`, `DocumentReffType` Invoice, `ApiIdentifier`, optional
   `Subject`/`ExternalComments`) via `createDocumentWithIdentifierValidation`.
8. **Idempotent recovery** — on a `duplicate_api_identifier` (API code **134**),
   confirm the existing receipt via `GetDocumentByApiIdentifier`; if found with a
   positive `DocumentNumber`, treat as `already_exists` (idempotent success, do
   **not** retry). On a `network_error`/timeout *after* submit, look the receipt
   up by `apiIdentifier`: found → resolved as created; proven absent
   (`document_not_found`) → retry the create **once** with the **same**
   `apiIdentifier`.
9. **Re-fetch** every referenced invoice and the receipt.
10. **Report** `{ status, receipt, invoices, verification }`, flagging
    `verification_failed` if the re-fetch fails or a balance no longer matches
    (`newBalance === previousBalance − allocation` for a fresh create; unchanged
    for `already_exists`).

### Write-gating

`server.ts#registerWriteTools` registers **nothing** when
`config.allowWrites` is false (the default). Only when
`INVOICE4U_ALLOW_WRITES=true` does the write tool appear in `tools/list`, and
only then with `readOnlyHint: false`.

## Error model

Every failure surfaces as one of **nine** `Invoice4uError` kinds. The client
maps verified API codes onto kinds in `errors.ts`:

| kind | `retryable` | API code(s) | meaning |
|---|---|---|---|
| `authentication_failed` | no | 80, 66; null result | bad/expired token or no org access |
| `invoice4u_validation_error` | no | 53; default | business/validation rejection |
| `document_not_found` | no | 321, 3, 37, 136, 7 | missing document/customer/id key |
| `duplicate_api_identifier` | no | 134 | idempotency key already used (write recovery) |
| `allocation_exceeds_balance` | no | 50 | allocation > open balance |
| `invoice_not_open` | no | 49 | referenced invoice not StatusID 1 |
| `network_error` | **yes** | 147; timeout | transport failure / HTTP 5xx |
| `verification_failed` | no | — | post-write re-fetch/balance mismatch |
| `unexpected_response` | no | — | shape/JSON/protocol surprise |

Only `network_error` is retryable by the client by default. **Writes are never
auto-retried** by the client; a write retry is a tool-level decision governed by
step 8 above.

## Money model

- The **MCP boundary** speaks **decimal strings** (`"1234.56"`), validated by
  `^\\d+(\\.\\d{1,2})?$`.
- **Internally** money is carried as canonical decimal strings, and arithmetic
  happens on **integer minor units** (agorot, fixed 2dp) in `money.ts`
  (`parseToMinor` / `fromMinor`). Integer `number` arithmetic is exact within
  ±2^53−1 minor units — far beyond any realistic invoice total.
- **No float arithmetic on values**, ever. The **only** sanctioned wire
  conversion is `floatFromApi`, which turns an API float total into a canonical
  decimal string via string round-trip to 2dp. At the write boundary, decimal
  strings become the wire float via `parseToMinor / 100`.
- `add`, `subtract`, `compare`, `equals` are all exact, tolerance-free, in
  integer minor units.

## Host allowlist

`config.ts`:

```ts
export const HOST_ALLOWLIST = {
  qa:         "https://apiqa.invoice4u.co.il/Services/ApiService.svc",
  production: "https://api.invoice4u.co.il/Services/ApiService.svc",
};
```

The base URL is **always** derived from the allowlist via `resolveBaseUrl(env)`.
There is no environment override and no arbitrary base-URL escape hatch: only
the two reviewed, official Invoice4U hosts are ever contacted. `INVOICE4U_ENV`
must be `qa` or `production` — there is no default, so the server refuses to
start rather than silently default to production.

## Design decisions

1. **API error 134 (duplicate identifier) is interpreted as transport-failure
   → tool-level idempotent success.** The API signals "already created" with
   `Errors:[{ID:134,…}]` alongside the existing receipt. The client surfaces
   134 as `duplicate_api_identifier`; the **write tool** (not the client) then
   confirms the existing receipt by `apiIdentifier` and reports
   `already_exists` with the previous/new balances — an idempotent success, not
   an error. The client layer stays neutral; interpretation is the tool's.
2. **The client never retries writes.** Auto-retrying a create risks duplicate
   documents. Retry is a tool decision: after a post-submit timeout, the tool
   first proves the document absent via `GetDocumentByApiIdentifier` and only
   then retries once with the same key.
3. **Reads retry on `network_error` only** (up to twice, backoff); no other
   kind is auto-retried.
4. **HTTP 200 + non-empty `Errors` is a failure**, on every call, not success.
5. **Write-gating is structural, not advisory** — the write tool is absent from
   `tools/list` when disabled.
6. **Money is never a float** across the MCP surface — decimal strings in,
   decimal strings out.
7. **No money movement** — creating a receipt records money already received;
   the server never initiates a payment or charges a card.
8. **Minimal, typed, allowlisted surface** — read/search/get operations are
   typed; arbitrary document creation and destructive/movement operations are
   excluded (see `docs/api-coverage.md` and `coverage-manifest.json`).