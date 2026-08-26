/**
 * Name ↔ code mappings between the MCP-facing vocabulary and the Invoice4U
 * wire codes (verified in the API reference 2026-08-26).
 *
 * The MCP surface speaks stable snake_case *names* (documentType, status,
 * payment method) so agents don't have to know the integer codes; these maps
 * translate to wire codes on the way out and back to names on the way in.
 */

import type { DocumentType, PaymentType, StatusID } from "../invoice4u/types.js";

/** MCP-facing document type names → wire codes (1/3/2/4/5/6/7/8). */
export const DOCUMENT_TYPE_BY_NAME = {
  invoice: 1,
  invoice_receipt: 3,
  receipt: 2,
  credit_invoice: 4,
  proforma: 5,
  order: 6,
  quote: 7,
  ship: 8,
} as const;
export type DocumentTypeName = keyof typeof DOCUMENT_TYPE_BY_NAME;

export const DOCUMENT_TYPE_NAME_BY_CODE: Readonly<Record<number, DocumentTypeName>> =
  Object.fromEntries(
    Object.entries(DOCUMENT_TYPE_BY_NAME).map(([name, code]) => [code, name]),
  ) as Record<number, DocumentTypeName>;

/** MCP-facing status names → wire StatusID codes (1..5). */
export const STATUS_BY_NAME = {
  open: 1,
  closed: 2,
  fully_credited: 3,
  partially_credited: 4,
  cancelled: 5,
} as const;
export type StatusName = keyof typeof STATUS_BY_NAME;

export const STATUS_NAME_BY_CODE: Readonly<Record<number, StatusName>> = Object.fromEntries(
  Object.entries(STATUS_BY_NAME).map(([name, code]) => [code, name]),
) as Record<number, StatusName>;

/**
 * Wire PaymentType codes → MCP-facing method name. Covers the full 1..9 range
 * seen on read paths (including Credit/5, which the write payment enum omits).
 */
export const PAYMENT_METHOD_NAME_BY_CODE: Readonly<Record<number, string>> = {
  1: "credit_card",
  2: "check",
  3: "bank_transfer",
  4: "cash",
  5: "credit",
  6: "withholding_tax",
  7: "other",
  8: "bit",
  9: "paybox",
};

export type { DocumentType, PaymentType, StatusID };
