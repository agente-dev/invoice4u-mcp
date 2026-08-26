/**
 * `invoice4u_get_document` — full document by exactly one lookup strategy.
 * Pure read; idempotent.
 *
 * Exactly one of three strategies must be supplied (zod refine rejects none
 * or several before the handler runs):
 *   1. `documentId` (GUID)                      → GetDocument
 *   2. `documentNumber` + `documentType`        → GetDocumentByNumber
 *   3. `apiIdentifier` (idempotency key)        → GetDocumentByApiIdentifier
 *      (`documentType` is optionally accepted alongside to scope the lookup)
 *
 * The result is a normalized document: snake_case fields, totals converted
 * from wire floats via `floatFromApi`, referenced documents surfaced as
 * `linkedInvoices`, payment methods as {code, name}, PDF links when present.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type DecimalMoney, floatFromApi } from "../invoice4u/money.js";
import type { Document, DocumentType } from "../invoice4u/types.js";
import {
  DOCUMENT_TYPE_BY_NAME,
  DOCUMENT_TYPE_NAME_BY_CODE,
  PAYMENT_METHOD_NAME_BY_CODE,
  STATUS_NAME_BY_CODE,
} from "./mappings.js";
import { guardedRead, READ_ANNOTATIONS, type ToolDeps } from "./support.js";

export const GET_DOCUMENT_TOOL_NAME = "invoice4u_get_document";

export const GET_DOCUMENT_DESCRIPTION =
  "Get one full document (invoice, receipt, proforma, ...) by exactly one of: " +
  "documentId (GUID), documentNumber + documentType, or apiIdentifier. " +
  "Returns normalized totals (decimal strings), payments, linked invoices and PDF links. Read-only.";

export const getDocumentInputSchema = {
  documentId: z.uuid().optional(),
  documentNumber: z.number().int().positive().optional(),
  documentType: z
    .enum([
      "invoice",
      "invoice_receipt",
      "receipt",
      "credit_invoice",
      "proforma",
      "order",
      "quote",
      "ship",
    ])
    .optional(),
  apiIdentifier: z.string().trim().min(1).max(200).optional(),
};

/** The raw lookup fields, checked for exactly-one-strategy. */
interface GetDocumentLookup {
  documentId?: string;
  documentNumber?: number;
  documentType?: string;
  apiIdentifier?: string;
}

/**
 * Exactly one of three strategies must be supplied:
 *   1. documentId; 2. documentNumber + documentType; 3. apiIdentifier.
 * A partial number/type pair (only one of the two) counts as invalid.
 */
function countLookupStrategies(value: GetDocumentLookup): number {
  let strategies = 0;
  if (value.documentId !== undefined) strategies += 1;
  const hasNumber = value.documentNumber !== undefined;
  const hasType = value.documentType !== undefined;
  if (hasNumber || hasType) {
    if (hasNumber && hasType) {
      strategies += 1;
    } else if (hasNumber) {
      return -1; // documentNumber without documentType is never a strategy
    }
    // documentType alone is only meaningful as a scoping hint alongside
    // apiIdentifier and does not count as its own strategy.
  }
  if (value.apiIdentifier !== undefined) strategies += 1;
  return strategies;
}

export const getDocumentInputObject = z
  .object(getDocumentInputSchema)
  .refine(
    (value) => countLookupStrategies(value) === 1,
    "Exactly one lookup strategy is required: either documentId (a GUID), or documentNumber together with documentType, or apiIdentifier (optionally scoped with documentType) — never more than one.",
  );
export type GetDocumentInput = z.infer<typeof getDocumentInputObject>;

/**
 * The schema actually registered on the tool: the refined object so the SDK's
 * input validation rejects zero/multiple lookup strategies with an McpError
 * before the handler runs (the raw field shape above is its base).
 */
export const getDocumentInputSchemaRegistered = getDocumentInputObject;

export interface GetDocumentPayment {
  method: { code: number; name: string };
  amount: DecimalMoney;
  date?: string;
  reference?: string;
}

export interface GetDocumentLinkedInvoice {
  documentId: string;
  allocatedAmount: DecimalMoney;
}

export interface GetDocumentResult {
  documentId: string;
  documentNumber?: number;
  documentType: string;
  status?: string;
  subject?: string;
  issueDate?: string;
  dueDate?: string;
  currency?: string;
  total?: DecimalMoney;
  totalWithoutTax?: DecimalMoney;
  totalTax?: DecimalMoney;
  customer?: { id?: number; name?: string };
  branchId?: number;
  payments?: GetDocumentPayment[];
  linkedInvoices?: GetDocumentLinkedInvoice[];
  apiIdentifier?: string;
  pdf?: { original?: string; certifiedCopy?: string };
}

function normalizeDocument(doc: Document): GetDocumentResult {
  const result: GetDocumentResult = {
    documentId: doc.ID,
    documentNumber: doc.DocumentNumber,
    documentType: DOCUMENT_TYPE_NAME_BY_CODE[doc.DocumentType] ?? String(doc.DocumentType),
    status: doc.StatusID === undefined ? undefined : STATUS_NAME_BY_CODE[doc.StatusID],
    subject: doc.Subject ?? undefined,
    issueDate: doc.IssueDate ?? undefined,
    dueDate: doc.PaymentDueDate ?? undefined,
    currency: doc.Currency ?? undefined,
    total: doc.Total === undefined ? undefined : floatFromApi(doc.Total),
    totalWithoutTax:
      doc.TotalWithoutTax === undefined ? undefined : floatFromApi(doc.TotalWithoutTax),
    totalTax: doc.TotalTaxAmount === undefined ? undefined : floatFromApi(doc.TotalTaxAmount),
    branchId: doc.BranchID ?? undefined,
    apiIdentifier: doc.ApiIdentifier ?? undefined,
  };

  const clientId = doc.ClientID ?? null;
  const generalCustomer = doc.GeneralCustomer ?? null;
  if (clientId !== null || generalCustomer !== null) {
    result.customer = {
      id: clientId ?? generalCustomer?.ID ?? undefined,
      name: generalCustomer?.Name ?? undefined,
    };
  }

  if (doc.Payments !== null && doc.Payments !== undefined && doc.Payments.length > 0) {
    result.payments = doc.Payments.map((payment) => ({
      method: {
        code: payment.PaymentType,
        name: PAYMENT_METHOD_NAME_BY_CODE[payment.PaymentType] ?? String(payment.PaymentType),
      },
      amount: floatFromApi(payment.Amount),
      date: payment.Date ?? payment.DateStr ?? undefined,
      reference: payment.PaymentNumber ?? undefined,
    }));
  }

  if (doc.DocumentReffType !== null && doc.DocumentReffType !== undefined) {
    if (doc.Invoices !== null && doc.Invoices !== undefined && doc.Invoices.length > 0) {
      result.linkedInvoices = doc.Invoices.map((ref) => ({
        documentId: ref.ID,
        allocatedAmount: floatFromApi(ref.ReceiptAmount),
      }));
    }
  }

  const originalLink = doc.PrintOriginalPDFLink ?? undefined;
  const certifiedLink = doc.PrintCertifiedCopyPDFLink ?? undefined;
  if (originalLink !== undefined || certifiedLink !== undefined) {
    result.pdf = { original: originalLink, certifiedCopy: certifiedLink };
  }

  return result;
}

export function createGetDocumentTool(deps: ToolDeps) {
  return {
    annotations: READ_ANNOTATIONS,
    handler: async (args: GetDocumentInput): Promise<CallToolResult> =>
      guardedRead(async () => {
        let doc: Document;
        if (args.documentId !== undefined) {
          doc = await deps.client.getDocument(args.documentId);
        } else if (args.apiIdentifier !== undefined) {
          // The apiIdentifier strategy is standalone (ApiIdentifier is unique
          // per organization), so no docType is forced: when the caller also
          // supplied a documentType we scope the lookup with it, otherwise the
          // wire op runs with the apiIdentifier alone and the API's own errors
          // surface naturally.
          const docType =
            args.documentType === undefined
              ? undefined
              : DOCUMENT_TYPE_BY_NAME[args.documentType as keyof typeof DOCUMENT_TYPE_BY_NAME];
          doc = await deps.client.call<Document>(
            "GetDocumentByApiIdentifier",
            docType === undefined
              ? { apiIdentifier: args.apiIdentifier }
              : { apiIdentifier: args.apiIdentifier, docType },
            "GetDocumentByApiIdentifierResult",
          );
        } else {
          const docType = DOCUMENT_TYPE_BY_NAME[
            args.documentType as keyof typeof DOCUMENT_TYPE_BY_NAME
          ] as DocumentType;
          doc = await deps.client.getDocumentByNumber(args.documentNumber as number, docType);
        }

        const data = normalizeDocument(doc);
        return {
          text: `Document ${data.documentNumber ?? data.documentId} (${data.documentType}) — ${data.total ?? "?"} ${data.currency ?? ""}`.trim(),
          data,
        };
      }),
  };
}
