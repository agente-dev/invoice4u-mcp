/**
 * Zod schemas for the MCP-facing input surface (Train C registers tool input
 * schemas from these). All money amounts are decimal strings — never floats —
 * and map to the wire as floats only at the very boundary.
 */

import { z } from "zod";
import { PaymentType } from "./types.js";

/** A decimal-string money value: digits with at most 2 fraction digits. */
export const DECIMAL_MONEY_RE = /^\d+(\.\d{1,2})?$/;

export const decimalMoneySchema = z
  .string()
  .regex(DECIMAL_MONEY_RE, "amount must be a decimal string with at most 2 fraction digits");

/** MCP-facing payment methods. Wire codes: see `paymentMethodToPaymentType`. */
export const paymentMethodEnum = z.enum([
  "bank_transfer",
  "cash",
  "check",
  "credit_card",
  "withholding_tax",
  "other",
  "bit",
  "paybox",
]);
export type PaymentMethod = z.infer<typeof paymentMethodEnum>;

/**
 * Payment method → wire PaymentType code (verified mapping:
 * bank_transfer→3 MoneyTransfer, cash→4, check→2, credit_card→1,
 * withholding_tax→6, other→7, bit→8, paybox→9).
 */
export const paymentMethodToPaymentType: Readonly<Record<PaymentMethod, number>> = {
  bank_transfer: PaymentType.MoneyTransfer,
  cash: PaymentType.Cash,
  check: PaymentType.Check,
  credit_card: PaymentType.CreditCard,
  withholding_tax: PaymentType.WithholdingTax,
  other: PaymentType.Other,
  bit: PaymentType.Bit,
  paybox: PaymentType.PayBox,
};

export const paymentInputSchema = z.object({
  /** MCP-facing payment method (mapped to a wire PaymentType before sending). */
  method: paymentMethodEnum,
  /** Amount as a decimal string, e.g. "1234.56". */
  amount: decimalMoneySchema,
  /** Check number / card last-4 / transfer reference. */
  reference: z.string().max(200).optional(),
  /** Bank account ID, when the payment references an account. */
  bankAccountId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;

export const allocationSchema = z.object({
  /** GUID of the open invoice (or proforma) being allocated against. */
  invoiceDocumentId: z.uuid(),
  /** Amount allocated from this receipt (decimal string). */
  amount: decimalMoneySchema,
});
export type Allocation = z.infer<typeof allocationSchema>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar-validity check ("2026-02-30" is rejected). */
function isRealDate(value: string): boolean {
  const parts = value.split("-").map(Number);
  if (parts.length !== 3) return false;
  const [year, month, day] = parts as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * A linked-receipt creation request (Receipt, DocumentType 2). ClientId must
 * reference an existing customer; payments (min 1) and invoiceAllocations
 * (min 1) are required, and the sum of payments must match the sum of
 * allocations unless the receipt is closed.
 */
export const createLinkedReceiptInputSchema = z.object({
  /** Idempotency key, unique per document in your system. */
  apiIdentifier: z.string().trim().min(1, "apiIdentifier is required").max(200),
  /** Existing customer ID (ClientID). */
  clientId: z.number().int().positive(),
  /** Payment date, YYYY-MM-DD and a real calendar date. */
  paymentDate: z
    .string()
    .regex(DATE_RE, "paymentDate must be YYYY-MM-DD")
    .refine(isRealDate, "paymentDate is not a valid calendar date"),
  payments: z.array(paymentInputSchema).min(1, "at least one payment is required"),
  invoiceAllocations: z
    .array(allocationSchema)
    .min(1, "at least one invoice allocation is required"),
  subject: z.string().max(500).optional(),
  remarks: z.string().max(2000).optional(),
});
export type CreateLinkedReceiptInput = z.infer<typeof createLinkedReceiptInputSchema>;
