/**
 * `invoice4u_validate_linked_receipt` — READ-ONLY preflight for creating a
 * linked receipt. It performs NO writes: it fetches the referenced invoices,
 * checks they exist and are open, verifies every allocation fits the
 * invoice's open balance, and verifies the payments total matches the
 * allocations total exactly (decimal-string arithmetic via money.ts).
 *
 * Failures are structured errors with one of the client's error kinds:
 * - document_not_found         — referenced invoice(s) missing (ids listed)
 * - invoice_not_open           — referenced invoice(s) not StatusID 1 (open)
 * - allocation_exceeds_balance — allocation > open balance (per invoice)
 * - invoice4u_validation_error — payments total != allocations total
 *
 * Input is exactly `createLinkedReceiptInputSchema` from schemas.ts.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Invoice4uErrorKind, isInvoice4uError } from "../invoice4u/errors.js";
import {
  add,
  compare,
  type DecimalMoney,
  equals,
  floatFromApi,
  subtract,
} from "../invoice4u/money.js";
import {
  type CreateLinkedReceiptInput,
  createLinkedReceiptInputSchema,
} from "../invoice4u/schemas.js";
import type { Document } from "../invoice4u/types.js";
import { StatusID } from "../invoice4u/types.js";
import { guardedRead, READ_ANNOTATIONS, type ToolDeps, ToolError } from "./support.js";

export const VALIDATE_LINKED_RECEIPT_TOOL_NAME = "invoice4u_validate_linked_receipt";

export const VALIDATE_LINKED_RECEIPT_DESCRIPTION =
  "Read-only preflight for creating a linked receipt: verifies the referenced " +
  "invoices exist and are open, that each allocation fits the invoice's open " +
  "balance, and that payments total exactly the allocations total. " +
  "Performs no writes. Read-only.";

/** Input is exactly the createLinkedReceiptInput schema — no deviation. */
export const validateLinkedReceiptInputSchema = createLinkedReceiptInputSchema.shape;
export type ValidateLinkedReceiptInput = CreateLinkedReceiptInput;

export interface ValidatedInvoice {
  documentId: string;
  documentNumber?: number;
  currentBalance: DecimalMoney;
  allocation: DecimalMoney;
}

export interface ValidateLinkedReceiptResult {
  valid: true;
  invoices: ValidatedInvoice[];
  totalPayments: DecimalMoney;
  totalAllocations: DecimalMoney;
  currency?: string;
}

/** Sum an array of decimal money strings exactly (minor-unit arithmetic). */
function sumAmounts(amounts: readonly string[]): DecimalMoney {
  return amounts.reduce<DecimalMoney>(
    (acc, amount) => add(acc, amount as DecimalMoney),
    "0.00" as DecimalMoney,
  );
}

/**
 * Open balance of an invoice: the API's own `Balance` when exposed, else
 * Total minus the sum of ReceiptAmounts already allocated against it.
 */
function openBalanceOf(invoice: Document): DecimalMoney {
  if (typeof invoice.Balance === "number") {
    return floatFromApi(invoice.Balance);
  }
  const total = floatFromApi(invoice.Total ?? 0);
  const paid = sumAmounts((invoice.Invoices ?? []).map((ref) => floatFromApi(ref.ReceiptAmount)));
  return subtract(total, paid);
}

function fail(kind: Invoice4uErrorKind, message: string, details: Record<string, unknown>): never {
  throw new ToolError(kind, message, { details });
}

export function createValidateLinkedReceiptTool(deps: ToolDeps) {
  return {
    annotations: READ_ANNOTATIONS,
    handler: async (args: CreateLinkedReceiptInput): Promise<CallToolResult> =>
      guardedRead(async () => {
        // Deduplicate: multiple allocations may reference the same invoice.
        const wantedIds = [
          ...new Set(args.invoiceAllocations.map((allocation) => allocation.invoiceDocumentId)),
        ];

        const invoices = new Map<string, Document>();
        const missing: string[] = [];
        for (const id of wantedIds) {
          try {
            const invoice = await deps.client.getDocument(id);
            invoices.set(id, invoice);
          } catch (error) {
            if (isInvoice4uError(error) && error.kind === "document_not_found") {
              missing.push(id);
            } else {
              throw error; // auth/network/other — surface as-is
            }
          }
        }
        if (missing.length > 0) {
          fail("document_not_found", `Referenced invoice(s) not found: ${missing.join(", ")}`, {
            documentIds: missing,
          });
        }

        // Every referenced invoice must be open (StatusID 1).
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
          fail(
            "invoice_not_open",
            `Referenced invoice(s) are not open: ${notOpen
              .map((entry) => `${entry.documentId} (status ${entry.status ?? "unknown"})`)
              .join(", ")}`,
            { invoices: notOpen },
          );
        }

        // Each allocation must fit the invoice's open balance.
        const validated: ValidatedInvoice[] = [];
        for (const allocation of args.invoiceAllocations) {
          const invoice = invoices.get(allocation.invoiceDocumentId);
          if (invoice === undefined) continue; // guarded above
          const balance = openBalanceOf(invoice);
          const amount = allocation.amount as DecimalMoney;
          if (compare(amount, balance) > 0) {
            fail(
              "allocation_exceeds_balance",
              `Allocation ${allocation.amount} exceeds the open balance ${balance} of invoice ${allocation.invoiceDocumentId}`,
              {
                invoice: {
                  documentId: allocation.invoiceDocumentId,
                  documentNumber: invoice.DocumentNumber,
                  allocation: allocation.amount,
                  balance,
                },
              },
            );
          }
          validated.push({
            documentId: allocation.invoiceDocumentId,
            documentNumber: invoice.DocumentNumber,
            currentBalance: balance,
            allocation: amount,
          });
        }

        // Payments must total exactly the allocations.
        const totalPayments = sumAmounts(args.payments.map((payment) => payment.amount));
        const totalAllocations = sumAmounts(
          args.invoiceAllocations.map((allocation) => allocation.amount),
        );
        if (!equals(totalPayments, totalAllocations)) {
          fail(
            "invoice4u_validation_error",
            `Payments total ${totalPayments} does not match allocations total ${totalAllocations}`,
            { totalPayments, totalAllocations },
          );
        }

        const firstCurrency = [...invoices.values()].find(
          (invoice) => invoice.Currency != null,
        )?.Currency;
        const data: ValidateLinkedReceiptResult = {
          valid: true,
          invoices: validated,
          totalPayments,
          totalAllocations,
          currency: firstCurrency ?? undefined,
        };
        return {
          text: `Preflight OK: ${validated.length} invoice(s) open with sufficients balance; payments ${totalPayments} match allocations ${totalAllocations}.`,
          data,
        };
      }),
  };
}
