/**
 * Typed error model for the Invoice4U client.
 *
 * Every failure the client surfaces is an `Invoice4uError` whose `kind` is
 * exactly one of the nine kinds below. The `Errors` envelope returned by the
 * API on HTTP 200 is normalized here via the error-code mapping verified in
 * the API reference:
 *
 *  80, 66            → authentication_failed
 *  134               → duplicate_api_identifier
 *  321, 3, 37, 136, 7 → document_not_found
 *  50                → allocation_exceeds_balance
 *  49                → invoice_not_open
 *  53                → invoice4u_validation_error
 *  147               → network_error
 *  anything else     → invoice4u_validation_error
 *
 * Only `network_error` is retryable by default.
 */

import type { CommonError } from "./types.js";

/** The exact set of error kinds the client can produce. */
export type Invoice4uErrorKind =
  | "authentication_failed"
  | "invoice4u_validation_error"
  | "document_not_found"
  | "duplicate_api_identifier"
  | "allocation_exceeds_balance"
  | "invoice_not_open"
  | "network_error"
  | "verification_failed"
  | "unexpected_response";

/** All nine kinds, in the canonical order (useful for exhaustive checks). */
export const INVOICE4U_ERROR_KINDS: readonly Invoice4uErrorKind[] = [
  "authentication_failed",
  "invoice4u_validation_error",
  "document_not_found",
  "duplicate_api_identifier",
  "allocation_exceeds_balance",
  "invoice_not_open",
  "network_error",
  "verification_failed",
  "unexpected_response",
] as const;

/** Common fields carried by every `Invoice4uError`. */
export interface Invoice4uErrorFields {
  readonly kind: Invoice4uErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  /** HTTP status when the failure came from a non-2xx response. */
  readonly httpStatus?: number;
  /** Raw API `CommonError[]` entries, when the failure came from the Errors envelope. */
  readonly apiErrors?: CommonError[];
  /** The idempotency key involved, when known (e.g. duplicate create). */
  readonly apiIdentifier?: string;
  /** The API operation name, e.g. "GetBranches". */
  readonly op?: string;
  /** The primary API error code, when known. */
  readonly code?: number;
}

/** Per-kind interfaces for discriminated narrowing. */
export interface AuthenticationFailedError extends Invoice4uErrorFields {
  kind: "authentication_failed";
  retryable: false;
}
export interface Invoice4uValidationError extends Invoice4uErrorFields {
  kind: "invoice4u_validation_error";
  retryable: false;
}
export interface DocumentNotFoundError extends Invoice4uErrorFields {
  kind: "document_not_found";
  retryable: false;
}
export interface DuplicateApiIdentifierError extends Invoice4uErrorFields {
  kind: "duplicate_api_identifier";
  retryable: false;
}
export interface AllocationExceedsBalanceError extends Invoice4uErrorFields {
  kind: "allocation_exceeds_balance";
  retryable: false;
}
export interface InvoiceNotOpenError extends Invoice4uErrorFields {
  kind: "invoice_not_open";
  retryable: false;
}
export interface NetworkError extends Invoice4uErrorFields {
  kind: "network_error";
  retryable: true;
}
export interface VerificationFailedError extends Invoice4uErrorFields {
  kind: "verification_failed";
  retryable: false;
}
export interface UnexpectedResponseError extends Invoice4uErrorFields {
  kind: "unexpected_response";
  retryable: false;
}

/**
 * The typed error union. A single class implements all members; the `kind`
 * discriminant is exactly one of the nine kinds above.
 */
export type Invoice4uError =
  | AuthenticationFailedError
  | Invoice4uValidationError
  | DocumentNotFoundError
  | DuplicateApiIdentifierError
  | AllocationExceedsBalanceError
  | InvoiceNotOpenError
  | NetworkError
  | VerificationFailedError
  | UnexpectedResponseError;

/**
 * Concrete error class. Instance values are assignable to the
 * `Invoice4uError` union (see the per-kind interfaces above).
 */
export class Invoice4uErrorImpl extends Error {
  readonly kind: Invoice4uErrorKind;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly apiErrors?: CommonError[];
  readonly apiIdentifier?: string;
  readonly op?: string;
  readonly code?: number;

  constructor(fields: Invoice4uErrorFields) {
    super(fields.message);
    this.name = "Invoice4uError";
    this.kind = fields.kind;
    this.retryable = fields.retryable;
    this.httpStatus = fields.httpStatus;
    this.apiErrors = fields.apiErrors;
    this.apiIdentifier = fields.apiIdentifier;
    this.op = fields.op;
    this.code = fields.code;
  }

  /**
   * Defensive redaction: replace every occurrence of `secret` in the message.
   * The client calls this with the API token before any error escapes — a
   * token must never appear in a thrown message.
   */
  redact(secret: string): this {
    if (secret.length >= 4 && this.message.includes(secret)) {
      this.message = this.message.split(secret).join("[REDACTED]");
    }
    return this;
  }
}

/** Only network errors are retryable by default. */
export function isRetryable(target: Invoice4uErrorKind | Pick<Invoice4uError, "kind">): boolean {
  const kind = typeof target === "string" ? target : target.kind;
  return kind === "network_error";
}

/** Narrow an unknown value to `Invoice4uError`. */
export function isInvoice4uError(value: unknown): value is Invoice4uError {
  return (
    value instanceof Invoice4uErrorImpl &&
    INVOICE4U_ERROR_KINDS.includes((value as Invoice4uErrorImpl).kind)
  );
}

/** Verified API error code → kind mapping (see module docs). */
const CODE_KIND_MAP: ReadonlyMap<number, Invoice4uErrorKind> = new Map([
  [80, "authentication_failed"],
  [66, "authentication_failed"],
  [134, "duplicate_api_identifier"],
  [321, "document_not_found"],
  [3, "document_not_found"],
  [37, "document_not_found"],
  [136, "document_not_found"],
  [7, "document_not_found"],
  [50, "allocation_exceeds_balance"],
  [49, "invoice_not_open"],
  [53, "invoice4u_validation_error"],
  [147, "network_error"],
]);

/** Map a raw API error code to its typed kind (default: validation error). */
export function kindForCode(code: number): Invoice4uErrorKind {
  return CODE_KIND_MAP.get(code) ?? "invoice4u_validation_error";
}

/** Construct a typed error from raw kind + fields, with derived retryable. */
export function createInvoice4uError(
  kind: Invoice4uErrorKind,
  fields: Omit<Invoice4uErrorFields, "kind" | "retryable">,
): Invoice4uError {
  // The runtime kind is exactly the literal passed in, so the class instance
  // always matches exactly one member of the union.
  return new Invoice4uErrorImpl({
    kind,
    retryable: isRetryable(kind),
    ...fields,
  }) as Invoice4uError;
}

/** Build a typed error from a non-empty API Errors envelope. */
export function fromApiErrors(
  errors: CommonError[],
  options: { op?: string; httpStatus?: number; apiIdentifier?: string } = {},
): Invoice4uError {
  const primary = errors[0] ?? { ID: 0, Error: "UnknownError" };
  const kind = kindForCode(primary.ID);
  const detail = primary.Error !== "" ? `${primary.Error} (${primary.ID})` : `code ${primary.ID}`;
  const message =
    options.op === undefined ? `Invoice4U API error: ${detail}` : `${options.op} failed: ${detail}`;
  return createInvoice4uError(kind, {
    message,
    op: options.op,
    httpStatus: options.httpStatus,
    apiErrors: errors,
    apiIdentifier: options.apiIdentifier,
    code: primary.ID,
  });
}
