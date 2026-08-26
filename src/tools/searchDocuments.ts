/**
 * `invoice4u_search_documents` — filtered document search (one document type
 * per call). Pure read; idempotent.
 *
 * The MCP surface uses snake_case names for documentType/status; they are
 * mapped to the wire integer codes here. Money filters/amounts travel as
 * decimal strings and are converted to wire floats at the boundary; returned
 * totals are converted from wire floats via `floatFromApi` (never float math).
 *
 * Pagination is a hint, not a loop: when the result count equals the limit,
 * `pageInfo.hasMoreData` is set so the caller can page — the tool never
 * auto-paginates.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type DecimalMoney, floatFromApi } from "../invoice4u/money.js";
import { decimalMoneySchema } from "../invoice4u/schemas.js";
import type { DocumentsRequest, DocumentType } from "../invoice4u/types.js";
import {
  DOCUMENT_TYPE_BY_NAME,
  DOCUMENT_TYPE_NAME_BY_CODE,
  STATUS_BY_NAME,
  STATUS_NAME_BY_CODE,
} from "./mappings.js";
import { guardedRead, READ_ANNOTATIONS, type ToolDeps } from "./support.js";

export const SEARCH_DOCUMENTS_TOOL_NAME = "invoice4u_search_documents";

export const SEARCH_DOCUMENTS_DESCRIPTION =
  "Search documents (invoices, receipts, proformas, orders, quotes, ships) " +
  "with optional filters (dates, customer, branch, status, amount range, " +
  "currency, exact document number). One document type per call. Read-only.";

export const searchDocumentsInputSchema = {
  documentType: z.enum([
    "invoice",
    "invoice_receipt",
    "receipt",
    "credit_invoice",
    "proforma",
    "order",
    "quote",
    "ship",
  ]),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be YYYY-MM-DD")
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be YYYY-MM-DD")
    .optional(),
  customerId: z.number().int().positive().optional(),
  customerName: z.string().max(200).optional(),
  branchId: z.number().int().positive().optional(),
  status: z
    .enum(["open", "closed", "fully_credited", "partially_credited", "cancelled"])
    .optional(),
  minAmount: decimalMoneySchema.optional(),
  maxAmount: decimalMoneySchema.optional(),
  currency: z.string().max(3).optional(),
  exactDocumentNumber: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(250).default(50),
};

export const searchDocumentsInputObject = z.object(searchDocumentsInputSchema);
export type SearchDocumentsInput = z.infer<typeof searchDocumentsInputObject>;

export interface SearchDocumentSummary {
  documentId: string;
  documentNumber?: number;
  documentType: string;
  status?: string;
  issueDate?: string;
  dueDate?: string;
  total?: DecimalMoney;
  currency?: string;
  customerId?: number;
}

export interface SearchDocumentsResult {
  documents: SearchDocumentSummary[];
  count: number;
  pageInfo?: { hasMoreData: boolean };
}

/** Decimal-string money → wire float (the sanctioned boundary conversion). */
function amountToWireFloat(value: string): number {
  return Number(value);
}

export function createSearchDocumentsTool(deps: ToolDeps) {
  return {
    annotations: READ_ANNOTATIONS,
    handler: async (args: SearchDocumentsInput): Promise<CallToolResult> =>
      guardedRead(async () => {
        const dr: DocumentsRequest = {
          DocumentType: DOCUMENT_TYPE_BY_NAME[args.documentType] as DocumentType,
          From: args.fromDate === undefined ? undefined : `${args.fromDate}T00:00:00`,
          To: args.toDate === undefined ? undefined : `${args.toDate}T00:00:00`,
          CustomerID: args.customerId ?? undefined,
          CustomerName: args.customerName,
          BranchID: args.branchId,
          Status: args.status === undefined ? undefined : STATUS_BY_NAME[args.status],
          FromAmount: args.minAmount === undefined ? undefined : amountToWireFloat(args.minAmount),
          ToAmount: args.maxAmount === undefined ? undefined : amountToWireFloat(args.maxAmount),
          Currency: args.currency,
          ExectDocumentNumber: args.exactDocumentNumber,
          ItemsIncluded: false,
          PaymentsIncluded: false,
          Limit: args.limit,
        };

        const docs = await deps.client.searchDocuments(dr);

        const documents: SearchDocumentSummary[] = docs.map((doc) => ({
          documentId: doc.ID,
          documentNumber: doc.DocumentNumber,
          documentType: DOCUMENT_TYPE_NAME_BY_CODE[doc.DocumentType] ?? String(doc.DocumentType),
          status: doc.StatusID === undefined ? undefined : STATUS_NAME_BY_CODE[doc.StatusID],
          issueDate: doc.IssueDate ?? undefined,
          dueDate: doc.PaymentDueDate ?? undefined,
          total: doc.Total === undefined ? undefined : floatFromApi(doc.Total),
          currency: doc.Currency ?? undefined,
          customerId: doc.ClientID ?? undefined,
        }));

        const data: SearchDocumentsResult = { documents, count: documents.length };
        if (documents.length === args.limit) {
          data.pageInfo = { hasMoreData: true };
        }
        return {
          text: `Found ${documents.length} ${args.documentType} document(s) matching the filter${
            documents.length === args.limit ? " (more results may exist — raise limit or page)" : ""
          }.`,
          data,
        };
      }),
  };
}
