# Invoice4U MCP — API Coverage (AGC-781, Train E)

This table maps the Invoice4U API surface (verified against the official
reference, 2026-08-26) to what this MCP server wraps, and what it deliberately
does **not** wrap, with reasons. The machine-readable twin of this document is
**[`coverage-manifest.json`](../coverage-manifest.json)** at the repo root
(schemaVersion 1) — it lists every tool, its wrapped operations, risk, and
`qaVerification` state.

## Wrapped surface

| Invoice4U API operation | MCP tool | Notes |
|---|---|---|
| `IsAuthenticated` | `invoice4u_verify_connection` | Token + org identity check. |
| `GetBranches` | `invoice4u_list_branches` | Also called by `verify_connection` for branch count. |
| `GetDocuments` | `invoice4u_search_documents` | One document type per call; filters normalized to names/enums. |
| `GetDocument` (GetDocument) | `invoice4u_get_document` (by `documentId`) | GUID fetch. |
| `GetDocumentByNumber` | `invoice4u_get_document` (by `documentNumber` + `documentType`) | Sequential numbers are per type. |
| `GetDocumentByApiIdentifier` | `invoice4u_get_document` (by `apiIdentifier`) | Idempotency-key lookup; also the write-recovery path. |
| `GetCustomersByOrgId` / `GetCustomers` | `invoice4u_search_customers` | Filtered search. |
| `GetFullCustomer` | `invoice4u_get_customer` | Full record: bank details, contacts, extra emails. |
| `CreateDocumentWithIdentifierValidation` | `invoice4u_create_linked_receipt` (write, gated) | Idempotent receipt create; API 134 → `already_exists`. |
| `GetDocument` (preflight) | `invoice4u_validate_linked_receipt` | Read-only preflight; never writes. |

Read tools declare `readOnlyHint: true, idempotentHint: true`. The write tool is
gated behind `INVOICE4U_ALLOW_WRITES=true` (absent from `tools/list` otherwise).

## Deliberately not wrapped

| Invoice4U area | Reason for exclusion |
|---|---|
| Clearing / payments (bank transactions, CSV parsing, matching, credit-card charging, stored cards, standing orders) | These move money or read sensitive banking data. Matching/pairing can allocate funds automatically; charging stored cards causes real payment movement. Excluded until financial-compliance review. |
| Inventory (items, warehouses, supplier-invoice-to-inventory) | Out of scope for the accounting-data read/write surface of v0.1. |
| Suppliers | Out of scope; no supplier read/write tool in v0.1. |
| User registration / org admin (hosted service, private packages, desktop integration) | Admin and platform concerns, not accounting-data paths. |
| Drafts / unrestricted document creation | Only the linked-receipt write is implemented; arbitrary document creation is not exposed. |
| Credit-invoice write (`InvoiceCredit` / cancellation) | Cancelling/crediting existing documents is a destructive, high-impact write — excluded from the write surface. |
| Raw request tool (generic passthrough) | A passthrough that POSTs arbitrary ops undermines the typed, allowlisted surface and the preflight safety checks. |
| Customer deletion | Permanent destructive operation; excluded. |

## Coverage manifest

`coverage-manifest.json` is the machine-readable twin of this document. It
lists, per tool: `name`, `wrappedOperations`, `risk` (`read`/`write`), the
`qaVerification` state (all `blocked_pending_credentials` until a live QA token
exists — see `docs/qa-testing.md`), and the referencing contract test. It also
enumerates the excluded API categories with the reasons above. Keep the manifest
and this document in sync when the surface changes.