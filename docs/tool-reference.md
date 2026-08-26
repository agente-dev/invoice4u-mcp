# Invoice4U MCP — Read Tool Reference (AGC-781, Train C)

All seven read tools are registered by `registerReadTools(server, { client, config })`
(`src/server.ts`) with the same annotations:
`readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.

Every tool answers `{ content: [human text], structuredContent }`. Expected API
failures are never thrown: they come back as `isError: true` with
`structuredContent.error = { kind, message, retryable, apiErrors?, details? }`
where `kind` is one of the nine `Invoice4uError` kinds. Malformed input is
rejected by the SDK's input validation (the refine text in the message).

Money is decimal-string only ("1234.56"). Wire floats are converted via
`floatFromApi`; filter amounts are converted to wire floats at the boundary.

| Tool | Input | Output (structuredContent) |
|---|---|---|
| `invoice4u_verify_connection` | — | `{ status: "ok", environment, organization: {userId, email, orgId}, branchCount, branches: [{id, name, isDefault}] }` |
| `invoice4u_search_documents` | `documentType` (name enum), `fromDate?`, `toDate?` (YYYY-MM-DD), `customerId?`, `customerName?`, `branchId?`, `status?` (open/closed/fully_credited/partially_credited/cancelled), `minAmount?`, `maxAmount?` (decimal), `currency?`, `exactDocumentNumber?`, `limit?` (1–250, default 50) | `{ documents: [{documentId, documentNumber?, documentType, status?, issueDate, dueDate?, total?, currency?, customerId?}], count, pageInfo?: {hasMoreData} }` — `pageInfo.hasMoreData = true` when `count === limit` (hint only, never auto-paginates) |
| `invoice4u_get_document` | exactly one of: `documentId` (uuid) · `documentNumber` + `documentType` · `apiIdentifier` (optionally scoped with `documentType`) | full normalized document: `{documentId, documentNumber?, documentType, status?, subject?, issueDate, dueDate?, currency, total?, totalWithoutTax?, totalTax?, customer?, branchId?, payments?, linkedInvoices?, apiIdentifier?, pdf?}` |
| `invoice4u_search_customers` | `name?`, `email?`, `limit?` (default 50) | `{ customers: [{customerId, name, email?, city?, phone?}], count }` — truncated client-side to `limit` |
| `invoice4u_get_customer` | `customerId` (positive int) | `{ id, name, email?, phones[], address?, bank?, externalNumber?, externalReference? }` — bank from the PayingAccount entry (or first) |
| `invoice4u_list_branches` | — | `{ branches: [{id, name, description?, enabled, isDefault, isMain, email?}], count }` — a null API result surfaces as `authentication_failed` |
| `invoice4u_validate_linked_receipt` | exactly `createLinkedReceiptInputSchema` (apiIdentifier, clientId, paymentDate, payments[1..], invoiceAllocations[1..], subject?, remarks?) | `{ valid: true, invoices: [{documentId, documentNumber?, currentBalance, allocation}], totalPayments, totalAllocations, currency? }` — read-only preflight, never writes |

## Error kinds (structured `error.kind`)

`authentication_failed`, `invoice4u_validation_error`, `document_not_found`,
`duplicate_api_identifier`, `allocation_exceeds_balance`, `invoice_not_open`,
`network_error`, `verification_failed`, `unexpected_response`.

`invoice4u_validate_linked_receipt` preflight failures carry `details`:
- `document_not_found` → `{ documentIds: [...] }`
- `invoice_not_open` → `{ invoices: [{documentId, documentNumber?, status}] }`
- `allocation_exceeds_balance` → `{ invoice: {documentId, documentNumber?, allocation, balance} }`
- `invoice4u_validation_error` (payments ≠ allocations) → `{ totalPayments, totalAllocations }`

## Wire mapping notes

- `documentType` names → codes: invoice 1, invoice_receipt 3, receipt 2,
  credit_invoice 4, proforma 5, order 6, quote 7, ship 8.
- `status` names → StatusID: open 1, closed 2, fully_credited 3,
  partially_credited 4, cancelled 5.
- Payment methods in `get_document.payments[].method = {code, name}`
  (credit_card 1, check 2, bank_transfer 3, cash 4, credit 5,
  withholding_tax 6, other 7, bit 8, paybox 9).
- `invoice4u_get_document` by `apiIdentifier` calls `GetDocumentByApiIdentifier`
  with the optional `docType` when a `documentType` was supplied.
