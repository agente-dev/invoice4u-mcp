/**
 * `invoice4u_create_linked_receipt` — the ONLY write tool of the AGC-781
 * surface (Train D). It creates a receipt (DocumentType 2) that allocates
 * payments across one or more referenced open invoices.
 *
 * It executes the full ten-step safety flow before and after submitting:
 *   1. zod schema (SDK-validated) — input is exactly `createLinkedReceiptInput`;
 *   2. apiIdentifier present/non-empty (enforced by the schema — it is the
 *      idempotency key, so it is mandatory);
 *   3. fetch EVERY referenced invoice via getDocument (deduplicated);
 *   4. verify each referenced invoice is open (StatusID 1) & eligible,
 *      else `invoice_not_open` (offenders listed);
 *   5. verify each allocation ≤ the invoice's current open balance (Balance, or
 *      Total − ΣReceiptAmounts), else `allocation_exceeds_balance`;
 *   6. verify Σpayments === Σallocations exactly (minor-unit arithmetic),
 *      else `invoice4u_validation_error`;
 *   7. build the CreateReceiptDoc (DocumentType 2, ClientID, Payments with the
 *      mapped wire PaymentType and a float Amount, Invoices with float
 *      ReceiptAmounts, DocumentReffType 1, the apiIdentifier, Subject?,
 *      ExternalComments=remarks?) and call
 *      `createDocumentWithIdentifierValidation`;
 *   8. idempotent recovery:
 *      - Errors contain 134 AND the returned receipt's DocumentNumber > 0 →
 *        `already_exists` (idempotent success — do NOT retry);
 *      - network_error/timeout AFTER submit → getDocumentByApiIdentifier:
 *        found → resolved as created; proven absent (document_not_found) →
 *        retry the create ONCE with the SAME apiIdentifier;
 *   9. re-fetch EVERY referenced invoice + the receipt;
 *  10. report {status, receipt, invoices, verification}, flagging
 *      `verification_failed` when the re-fetch fails or a balance no longer
 *      matches (newBalance === previousBalance − allocation for a fresh
 *      create; unchanged for an idempotent already_exists).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Invoice4uErrorKind, isInvoice4uError } from "../invoice4u/errors.js";
import {
  add,
  compare,
  type DecimalMoney,
  equals,
  floatFromApi,
  parseToMinor,
  subtract,
} from "../invoice4u/money.js";
import {
  type CreateLinkedReceiptInput,
  createLinkedReceiptInputSchema,
  paymentMethodToPaymentType,
} from "../invoice4u/schemas.js";
import type { CreateReceiptDoc, Document, Payment, PaymentType } from "../invoice4u/types.js";
import { DocumentType, StatusID } from "../invoice4u/types.js";
import { structuredErrorResult, type ToolDeps, WRITE_ANNOTATIONS } from "./support.js";

export const CREATE_LINKED_RECEIPT_TOOL_NAME = "invoice4u_create_linked_receipt";

export const CREATE_LINKED_RECEIPT_DESCRIPTION =
  "Create a linked receipt that allocates payments across one or more open " +
  "invoices. It verifies every referenced invoice exists and is open, that each " +
  "allocation fits the invoice's open balance, and that payments total exactly " +
  "the allocations. Idempotent: `apiIdentifier` is a REQUIRED, unique-per-document " +
  "idempotency key — repeating the same call with the same apiIdentifier returns " +
  "the already-created receipt instead of creating a duplicate.";

/** Registered verbatim from schemas.ts — input is exactly createLinkedReceiptInput. */
export const createLinkedReceiptInputSchemaRegistered = createLinkedReceiptInputSchema;

export type CreateLinkedReceiptResultStatus =
  | "created"
  | "already_exists"
  | "validation_failed"
  | "verification_failed";

export interface CreateLinkedReceiptInvoiceState {
  documentId: string;
  documentNumber?: number;
  previousBalance?: DecimalMoney;
  newBalance?: DecimalMoney;
  status?: StatusID;
}

export interface CreateLinkedReceiptFailure {
  kind: Invoice4uErrorKind;
  message: string;
}

export interface CreateLinkedReceiptResult {
  status: CreateLinkedReceiptResultStatus;
  receipt: {
    receiptId?: string;
    documentNumber?: number;
    apiIdentifier?: string;
    total?: DecimalMoney;
  } | null;
  invoices: CreateLinkedReceiptInvoiceState[];
  verification: {
    receiptFetched: boolean;
    invoicesReFetched: boolean;
    balancesConsistent: boolean;
  };
  failures?: CreateLinkedReceiptFailure[];
}

/** Sum an array of decimal money strings exactly (minor-unit arithmetic). */
function sumAmounts(amounts: readonly string[]): DecimalMoney {
  return amounts.reduce<DecimalMoney>(
    (acc, amount) => add(acc, amount as DecimalMoney),
    "0.00" as DecimalMoney,
  );
}

/** Open balance of an invoice: the API's own `Balance` when exposed, else Total minus allocations. */
function openBalanceOf(invoice: Document): DecimalMoney {
  if (typeof invoice.Balance === "number") {
    return floatFromApi(invoice.Balance);
  }
  const total = floatFromApi(invoice.Total ?? 0);
  const paid = sumAmounts((invoice.Invoices ?? []).map((ref) => floatFromApi(ref.ReceiptAmount)));
  return subtract(total, paid);
}

/** floatFromApi-inverse: decimal-string money → the wire float (minor / 100). */
function amountToFloat(amount: string): number {
  return parseToMinor(amount) / 100;
}

/**
 * Recovery lookup for the idempotency key: returns the receipt document when
 * it exists, `null` when proven absent (document_not_found), and rethrows any
 * other error (auth, unexpected_response, ...).
 */
async function lookupReceipt(deps: ToolDeps, apiIdentifier: string): Promise<Document | null> {
  try {
    return await deps.client.getDocumentByApiIdentifier(apiIdentifier, DocumentType.Receipt);
  } catch (error) {
    if (isInvoice4uError(error) && error.kind === "document_not_found") return null;
    throw error;
  }
}

interface SubmitOutcome {
  status: "created" | "already_exists";
  doc: Document;
}

/**
 * Step 8: submit the receipt with the AGC-781 idempotent-recovery contract.
 * The client never auto-retries writes; retries here are the tool's decision.
 */
async function submitReceipt(
  deps: ToolDeps,
  doc: CreateReceiptDoc,
  apiIdentifier: string,
): Promise<SubmitOutcome> {
  try {
    const created = await deps.client.createDocumentWithIdentifierValidation(doc);
    return { status: "created", doc: created };
  } catch (error) {
    if (!isInvoice4uError(error)) throw error;

    if (error.kind === "duplicate_api_identifier") {
      // 134 — idempotent. Confirm the existing receipt via its apiIdentifier.
      const existing = await lookupReceipt(deps, apiIdentifier);
      if (existing && (existing.DocumentNumber ?? 0) > 0) {
        return { status: "already_exists", doc: existing };
      }
      throw error;
    }

    if (error.kind === "network_error") {
      // timeout AFTER submit — recover via GetDocumentByApiIdentifier.
      const found = await lookupReceipt(deps, apiIdentifier);
      if (found) return { status: "created", doc: found };
      // Proven absent → retry the create ONCE with the same apiIdentifier.
      try {
        const retried = await deps.client.createDocumentWithIdentifierValidation(doc);
        return { status: "created", doc: retried };
      } catch (retryError) {
        if (isInvoice4uError(retryError) && retryError.kind === "network_error") {
          const foundAgain = await lookupReceipt(deps, apiIdentifier);
          if (foundAgain) return { status: "created", doc: foundAgain };
        }
        throw retryError;
      }
    }

    throw error;
  }
}

/** A preflight failure returned as a `validation_failed` status result. */
function validationFailedResult(
  kind: Invoice4uErrorKind,
  message: string,
  details: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: `validation_failed: ${message}` }],
    structuredContent: {
      status: "validation_failed",
      failures: [{ kind, message, details }],
      receipt: null,
      invoices: [],
      verification: { receiptFetched: false, invoicesReFetched: false, balancesConsistent: false },
    },
  };
}

/** The full ten-step flow. Preflight failures are never submitted. */
async function execute(deps: ToolDeps, args: CreateLinkedReceiptInput): Promise<CallToolResult> {
  // Deduplicate: multiple allocations may reference the same invoice.
  const wantedIds = [
    ...new Set(args.invoiceAllocations.map((allocation) => allocation.invoiceDocumentId)),
  ];

  // --- Step 3: fetch EVERY referenced invoice via getDocument ----------------
  const invoices = new Map<string, Document>();
  const missing: string[] = [];
  for (const id of wantedIds) {
    try {
      invoices.set(id, await deps.client.getDocument(id));
    } catch (error) {
      if (isInvoice4uError(error) && error.kind === "document_not_found") missing.push(id);
      else throw error;
    }
  }
  if (missing.length > 0) {
    return validationFailedResult(
      "document_not_found",
      `Referenced invoice(s) not found: ${missing.join(", ")}`,
      {
        documentIds: missing,
      },
    );
  }

  // --- Step 4: every referenced invoice must be open (StatusID 1) ------------
  const notOpen: { documentId: string; documentNumber?: number; status?: number }[] = [];
  for (const id of wantedIds) {
    const invoice = invoices.get(id);
    if (invoice !== undefined && invoice.StatusID !== StatusID.Open) {
      notOpen.push({
        documentId: id,
        documentNumber: invoice.DocumentNumber,
        status: invoice.StatusID,
      });
    }
  }
  if (notOpen.length > 0) {
    return validationFailedResult(
      "invoice_not_open",
      `Referenced invoice(s) are not open: ${notOpen.map((entry) => `${entry.documentId} (status ${entry.status ?? "unknown"})`).join(", ")}`,
      { invoices: notOpen },
    );
  }

  // --- Step 5: each allocation ≤ the invoice's open balance ------------------
  const preBalanceByInvoice = new Map<string, DecimalMoney>();
  const allocSumByInvoice = new Map<string, DecimalMoney>();
  const exceeds: {
    documentId: string;
    documentNumber?: number;
    allocation: string;
    balance: DecimalMoney;
  }[] = [];
  for (const allocation of args.invoiceAllocations) {
    const invoice = invoices.get(allocation.invoiceDocumentId);
    if (invoice === undefined) continue; // guarded above
    const balance = openBalanceOf(invoice);
    preBalanceByInvoice.set(allocation.invoiceDocumentId, balance);
    const amount = allocation.amount as DecimalMoney;
    allocSumByInvoice.set(
      allocation.invoiceDocumentId,
      add(allocSumByInvoice.get(allocation.invoiceDocumentId) ?? ("0.00" as DecimalMoney), amount),
    );
    if (compare(amount, balance) > 0) {
      exceeds.push({
        documentId: allocation.invoiceDocumentId,
        documentNumber: invoice.DocumentNumber,
        allocation: allocation.amount,
        balance,
      });
    }
  }
  if (exceeds.length > 0) {
    return validationFailedResult(
      "allocation_exceeds_balance",
      `Allocation(s) exceed the open balance: ${exceeds.map((entry) => `${entry.documentId} (allocation ${entry.allocation}, balance ${entry.balance})`).join(", ")}`,
      { invoices: exceeds },
    );
  }

  // --- Step 6: payments total must equal allocations total exactly -----------
  const totalPayments = sumAmounts(args.payments.map((payment) => payment.amount));
  const totalAllocations = sumAmounts(
    args.invoiceAllocations.map((allocation) => allocation.amount),
  );
  if (!equals(totalPayments, totalAllocations)) {
    return validationFailedResult(
      "invoice4u_validation_error",
      `Payments total ${totalPayments} does not match allocations total ${totalAllocations}`,
      { totalPayments, totalAllocations },
    );
  }

  // --- Step 7: build the CreateReceiptDoc and submit --------------------------
  const doc: CreateReceiptDoc = {
    DocumentType: 2,
    ClientID: args.clientId,
    ApiIdentifier: args.apiIdentifier,
    Payments: args.payments.map((payment): Payment => {
      const wire: Payment = {
        PaymentType: paymentMethodToPaymentType[payment.method] as PaymentType,
        Amount: amountToFloat(payment.amount),
        Date: args.paymentDate,
      };
      if (payment.reference !== undefined) wire.PaymentNumber = payment.reference;
      return wire;
    }),
    Invoices: args.invoiceAllocations.map((allocation) => ({
      ID: allocation.invoiceDocumentId,
      ReceiptAmount: amountToFloat(allocation.amount),
    })),
    DocumentReffType: DocumentType.Invoice,
    ...(args.subject !== undefined ? { Subject: args.subject } : {}),
    ...(args.remarks !== undefined ? { ExternalComments: args.remarks } : {}),
  };

  const submitted = await submitReceipt(deps, doc, args.apiIdentifier);
  const didCreate = submitted.status === "created";

  // --- Step 9: re-fetch EVERY referenced invoice + the receipt ----------------
  const baseInvoices = wantedIds.map((id) => ({
    documentId: id,
    documentNumber: invoices.get(id)?.DocumentNumber,
    previousBalance: preBalanceByInvoice.get(id) ?? ("0.00" as DecimalMoney),
    allocationSum: allocSumByInvoice.get(id) ?? ("0.00" as DecimalMoney),
  }));
  const outputInvoices: CreateLinkedReceiptInvoiceState[] = baseInvoices.map((entry) => ({
    documentId: entry.documentId,
    documentNumber: entry.documentNumber,
    previousBalance: entry.previousBalance,
  }));

  let receiptFetched = false;
  let invoicesReFetched = false;
  let balancesConsistent = false;
  let receiptDoc: Document | undefined;
  const failures: CreateLinkedReceiptFailure[] = [];

  try {
    const freshInvoices = new Map<string, Document>();
    for (const id of wantedIds) {
      freshInvoices.set(id, await deps.client.getDocument(id));
    }
    invoicesReFetched = true;
    for (const fresh of freshInvoices.values()) {
      const output = outputInvoices.find((entry) => entry.documentId === fresh.ID);
      if (output === undefined) continue;
      output.newBalance = openBalanceOf(fresh);
      output.status = fresh.StatusID;
    }

    const receipt = await deps.client.getDocumentByApiIdentifier(
      args.apiIdentifier,
      DocumentType.Receipt,
    );
    receiptFetched = true;
    receiptDoc = receipt ?? undefined;

    // For a fresh create the balance must drop by the allocation; for an
    // idempotent already_exists the balance must be unchanged.
    balancesConsistent = outputInvoices.every((output) => {
      if (output.newBalance === undefined) return false;
      const alloc = allocSumByInvoice.get(output.documentId) ?? ("0.00" as DecimalMoney);
      const expected = didCreate
        ? subtract(output.previousBalance ?? ("0.00" as DecimalMoney), alloc)
        : (output.previousBalance ?? ("0.00" as DecimalMoney));
      return compare(output.newBalance, expected) === 0;
    });
  } catch (error) {
    failures.push({
      kind: isInvoice4uError(error) ? error.kind : "verification_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // --- Step 10: report --------------------------------------------------------
  let status: CreateLinkedReceiptResultStatus = submitted.status;
  if (failures.length > 0 || !balancesConsistent) status = "verification_failed";

  const receiptForReport = receiptDoc ?? submitted.doc;
  const total =
    receiptForReport.Total !== undefined
      ? floatFromApi(receiptForReport.Total)
      : sumAmounts(args.payments.map((payment) => payment.amount));

  return {
    content: [
      {
        type: "text",
        text: `${status}: receipt ${receiptForReport.DocumentNumber ?? receiptForReport.ID} created/allocated ${total} against ${outputInvoices.length} invoice(s).`,
      },
    ],
    structuredContent: {
      status,
      receipt: {
        receiptId: receiptForReport.ID,
        documentNumber: receiptForReport.DocumentNumber,
        apiIdentifier: args.apiIdentifier,
        total,
      },
      invoices: outputInvoices,
      verification: { receiptFetched, invoicesReFetched, balancesConsistent },
      ...(failures.length > 0 ? { failures } : {}),
    },
  };
}

export function createCreateLinkedReceiptTool(deps: ToolDeps) {
  return {
    annotations: WRITE_ANNOTATIONS,
    handler: async (args: CreateLinkedReceiptInput): Promise<CallToolResult> => {
      try {
        return await execute(deps, args);
      } catch (error) {
        // Unexpected hard failures (auth, unexpected_response, raise-on-read,
        // or an API rejection after submit we couldn't recover) surface as a
        // structured error — never thrown.
        if (isInvoice4uError(error)) {
          return structuredErrorResult(error);
        }
        throw error;
      }
    },
  };
}
