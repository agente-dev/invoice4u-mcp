# Reconciliation example — bank export → linked receipt (kashrut-style)

This is a worked example of reconciling a bank statement to open invoices and
creating a linked receipt for a deposit. **All data is synthetic** — no real
customer, invoice, or bank data appears anywhere.

The scenario: on **2026-08-25** a client's bank statement shows a wired deposit
of **1,250.00 ₪**. Two open invoices from that client still have balances that
together sum to 1,250.00. We allocate the full deposit across them and create a
receipt.

Assumes `INVOICE4U_ALLOW_WRITES=true` (see write-gating in
`docs/tool-reference.md`).

## 0. Bank export (external, not a tool)

A row from the (external, non-MCP) bank CSV export:

```
Date         Description          Amount     Balance
2026-08-25   Deposit — wire        1250.00    4_160.25
```

We turn this into a **stable idempotency key** for the receipt:
`bank-2026-08-25-line-7`. This key is stable across replays so the same deposit
never creates two receipts.

## 1. Match deposits to open invoices — `invoice4u_search_documents`

Find this client's open invoices (status `open`, DocumentType 1 — invoices).

```json
{
  "name": "invoice4u_search_documents",
  "arguments": {
    "documentType": "invoice",
    "status": "open",
    "customerName": "Synthetic Customer Ltd",
    "toDate": "2026-08-25"
  }
}
```

Response (synthetic — truncated for brevity):

```json
{
  "content": [{ "type": "text", "text": "2 open invoice(s) found." }],
  "structuredContent": {
    "documents": [
      {
        "documentId": "a1111111-2222-3333-4444-555555555501",
        "documentNumber": 101,
        "documentType": "invoice",
        "status": "open",
        "issueDate": "2026-08-01",
        "dueDate": "2026-08-15",
        "total": "850.00",
        "currency": "ILS",
        "customerId": 42
      },
      {
        "documentId": "a1111111-2222-3333-4444-555555555502",
        "documentNumber": 102,
        "documentType": "invoice",
        "status": "open",
        "issueDate": "2026-08-10",
        "dueDate": "2026-08-24",
        "total": "400.00",
        "currency": "ILS",
        "customerId": 42
      }
    ],
    "count": 2,
    "pageInfo": { "hasMoreData": false }
  }
}
```

Two open invoices, balances 850.00 + 400.00 = 1,250.00 — exactly the deposit.

## 2. Preflight validation — `invoice4u_validate_linked_receipt`

Run the **read-only preflight** with `apiIdentifier` = `bank-2026-08-25-line-7`,
both invoices open, and a single bank-transfer payment of 1,250.00.

```json
{
  "name": "invoice4u_validate_linked_receipt",
  "arguments": {
    "apiIdentifier": "bank-2026-08-25-line-7",
    "clientId": 42,
    "paymentDate": "2026-08-25",
    "payments": [
      { "method": "bank_transfer", "amount": "1250.00", "reference": "wire-ref-8821" }
    ],
    "invoiceAllocations": [
      { "invoiceDocumentId": "a1111111-2222-3333-4444-555555555501", "amount": "850.00" },
      { "invoiceDocumentId": "a1111111-2222-3333-4444-555555555502", "amount": "400.00" }
    ],
    "remarks": "Bank deposit 2026-08-25, line 7"
  }
}
```

The preflight confirms both invoices are open, each allocation fits its balance,
and payments (1,250.00) equal allocations (1,250.00):

```json
{
  "structuredContent": {
    "valid": true,
    "invoices": [
      { "documentId": "a1111111-2222-3333-4444-555555555501", "documentNumber": 101, "currentBalance": "850.00", "allocation": "850.00" },
      { "documentId": "a1111111-2222-3333-4444-555555555502", "documentNumber": 102, "currentBalance": "400.00", "allocation": "400.00" }
    ],
    "totalPayments": "1250.00",
    "totalAllocations": "1250.00",
    "currency": "ILS"
  }
}
```

## 3. Create the linked receipt (idempotent write)

Submit the identical payload to `invoice4u_create_linked_receipt` with the same
**stable** `apiIdentifier`.

```json
{
  "name": "invoice4u_create_linked_receipt",
  "arguments": {
    "apiIdentifier": "bank-2026-08-25-line-7",
    "clientId": 42,
    "paymentDate": "2026-08-25",
    "payments": [
      { "method": "bank_transfer", "amount": "1250.00", "reference": "wire-ref-8821" }
    ],
    "invoiceAllocations": [
      { "invoiceDocumentId": "a1111111-2222-3333-4444-555555555501", "amount": "850.00" },
      { "invoiceDocumentId": "a1111111-2222-3333-4444-555555555502", "amount": "400.00" }
    ],
    "remarks": "Bank deposit 2026-08-25, line 7"
  }
}
```

Response:

```json
{
  "content": [{ "type": "text", "text": "created: receipt 5001 created/allocated 1250.00 against 2 invoice(s)." }],
  "structuredContent": {
    "status": "created",
    "receipt": { "receiptId": "b2222222-3333-4444-5555-666666666601", "documentNumber": 5001, "apiIdentifier": "bank-2026-08-25-line-7", "total": "1250.00" },
    "invoices": [
      { "documentId": "a1111111-2222-3333-4444-555555555501", "documentNumber": 101, "previousBalance": "850.00", "newBalance": "0.00", "status": 2 },
      { "documentId": "a1111111-2222-3333-4444-555555555502", "documentNumber": 102, "previousBalance": "400.00", "newBalance": "0.00", "status": 2 }
    ],
    "verification": { "receiptFetched": true, "invoicesReFetched": true, "balancesConsistent": true }
  }
}
```

### Interpreting the verification block

- `status: "created"` — a fresh receipt (DocumentNumber **5001**) was created.
- `verification.receiptFetched: true` — the receipt was re-fetched after the write.
- `verification.invoicesReFetched: true` — both referenced invoices were re-fetched.
- **`balancesConsistent: true`** is what you trust: for a fresh create each
  `newBalance` equals `previousBalance − allocation`
  (850.00 → 0.00, 400.00 → 0.00). Both invoices are now `status: 2` (closed).

If `balancesConsistent` were `false`, the receipt may still exist — reconcile by
`apiIdentifier` and treat the outcome as `verification_failed`; do **not**
blindly re-create.

## 4. Replay / already_exists

If the same deposit row is processed again (a replay of the reconciliation run
with the same stable key `bank-2026-08-25-line-7`), the write tool detects the
duplicate identifier (API code 134), finds the existing receipt, and returns an
idempotent success — **no second receipt is created**:

```json
{
  "content": [{ "type": "text", "text": "already_exists: receipt 5001 created/allocated 1250.00 against 2 invoice(s)." }],
  "structuredContent": {
    "status": "already_exists",
    "receipt": { "receiptId": "b2222222-3333-4444-5555-666666666601", "documentNumber": 5001, "apiIdentifier": "bank-2026-08-25-line-7", "total": "1250.00" },
    "invoices": [
      { "documentId": "a1111111-2222-3333-4444-555555555501", "documentNumber": 101, "previousBalance": "0.00", "newBalance": "0.00", "status": 2 },
      { "documentId": "a1111111-2222-3333-4444-555555555502", "documentNumber": 102, "previousBalance": "0.00", "newBalance": "0.00", "status": 2 }
    ],
    "verification": { "receiptFetched": true, "invoicesReFetched": true, "balancesConsistent": true }
  }
}
```

On `already_exists`, `balancesConsistent` for a replay means the balances are
**unchanged** (`previousBalance === newBalance`) — the correct invariant for an
idempotent success. Both invoices remain closed at 0.00.

## Key takeaways

- Derive the `apiIdentifier` from the **source row** (e.g.
  `bank-2026-08-25-line-7`) and keep it stable so replays are idempotent.
- Always run `invoice4u_validate_linked_receipt` first — it is read-only and
  catches not-open / over-allocation / mismatch before any write.
- Trust `verification.balancesConsistent` before acting on the result.
- On `verification_failed`, look the receipt up by `apiIdentifier` — never
  blindly retry the create.