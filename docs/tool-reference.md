# Invoice4U MCP — Tool Reference (AGC-781, Trains C + D)

All seven read tools are registered by `registerReadTools(server, { client, config })`
(`src/server.ts`) with the same annotations:
`readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.

The single write tool is registered by `registerWriteTools(server, { client, config })`
**only when `config.allowWrites` is true** (see the write-gating note below).

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
| `invoice4u_create_linked_receipt` | exactly `createLinkedReceiptInputSchema` (see below) | `{ status, receipt, invoices, verification }` — statuses `created \| already_exists \| validation_failed \| verification_failed` |

## `invoice4u_create_linked_receipt` (write, gated)

The **only** write tool of the v0.1 surface. It creates a receipt (DocumentType 2)
that allocates payments across one or more referenced open invoices. It is **idempotent**
because `apiIdentifier` is a **mandatory**, unique-per-document idempotency key:
repeating the same call with the same `apiIdentifier` returns the already-created receipt
instead of creating a duplicate.

**Write-gating:** this tool is **not registered at all** (absent from `tools/list`) unless
`INVOICE4U_ALLOW_WRITES=true`. When registered it carries
`readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`.

### Input (exactly `createLinkedReceiptInput`)

```ts
{
  apiIdentifier: string;          // REQUIRED idempotency key — trim, 1..200 chars
  clientId: number;               // existing customer ID (ClientID), positive int
  paymentDate: string;            // YYYY-MM-DD, real calendar date
  payments: [{                    // at least one
    method: "bank_transfer"|"cash"|"check"|"credit_card"|"withholding_tax"|"other"|"bit"|"paybox",
    amount: string;               // decimal money string, e.g. "1234.56"
    reference?: string;           // check number / card last-4 / transfer reference (max 200)
    bankAccountId?: number;       // positive int, when the payment references an account
    notes?: string;               // max 2000
  }],
  invoiceAllocations: [{          // at least one
    invoiceDocumentId: string;    // GUID of an open invoice being allocated against
    amount: string;               // decimal money string
  }],
  subject?: string;               // max 500
  remarks?: string;               // max 2000 (sent as ExternalComments)
}
```

### Output (structuredContent)

```ts
{
  status: "created" | "already_exists" | "validation_failed" | "verification_failed";
  receipt: { receiptId?: string; documentNumber?: number; apiIdentifier?: string; total?: string } | null;
  invoices: [{ documentId: string; documentNumber?: number; previousBalance?: string; newBalance?: string; status?: number }];
  verification: { receiptFetched: boolean; invoicesReFetched: boolean; balancesConsistent: boolean };
  failures?: [{ kind: string; message: string }];   // present on validation_failed / verification_failed
}
```

### Status semantics

| status | meaning |
|---|---|
| `created` | The receipt was created (or a post-submit timeout resolved to it via `apiIdentifier` lookup). |
| `already_exists` | A receipt with this `apiIdentifier` already existed (API code **134**); the existing receipt is returned. Idempotent success, not an error. |
| `validation_failed` | Preflight rejected the request before any write (bad id, not-open, over-allocation, payments≠allocations). `failures[]` carries the reason(s). |
| `verification_failed` | The write/submit happened but the post-write re-fetch of invoices/receipt failed or a balance no longer matches. Check `failures[]` and reconcile manually. |

### Wire mapping notes (write)

- `payments[].method` → wire `PaymentType` code (verified): bank_transfer→3,
  cash→4, check→2, credit_card→1, withholding_tax→6, other→7, bit→8, paybox→9.
- Amounts leave as wire floats via `parseToMinor(amount)/100`; allocation
  `ReceiptAmount`s likewise. `DocumentReffType` = Invoice (1).
- On input-validation failure the SDK rejects the call before the handler runs.
- A timeout after submit is resolved through `GetDocumentByApiIdentifier`; the
  create is retried only when the lookup proves no document exists (never blindly).

## Coverage manifest

For a machine-readable twin of the tool/operation surface and its QA-verification
state, see **[`coverage-manifest.json`](../coverage-manifest.json)** at the repo
root (schemaVersion 1). It lists every tool, the wrapped Invoice4U operations,
risk (read/write), the `qaVerification` state (`blocked_pending_credentials` for
all until a live token exists), and the excluded API categories with reasons.