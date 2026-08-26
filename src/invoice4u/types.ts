/**
 * Typed Invoice4U wire types.
 *
 * Verified against the Invoice4U API reference (invoice4u.gitbook.io, 2026-08-26)
 * and the OpenAPI schemas embedded in the documentation pages.
 *
 * Conventions:
 * - Every response object inherits the CommonObject envelope. WCF returns HTTP 200
 *   with a non-empty `Errors` array on BUSINESS failures — callers MUST check errors
 *   before trusting any payload (the client normalizes this on every call).
 * - Monetary fields (`Total`, `ReceiptAmount`, `Balance`, `Payment.Amount`, ...)
 *   arrive as JSON floats. They are typed `number` here, but all public conversion
 *   and arithmetic goes through `src/invoice4u/money.ts` — never float math.
 * - The API spells the field `Paramters` (typo preserved) on `CommonError`.
 */

/** A single error entry from the API's Errors envelope. */
export interface CommonError {
  /** Numeric error code, e.g. 80 = UnauthorizedUser, 134 = DocumentAlreadyCreated. */
  ID: number;
  /** Error name. */
  Error: string;
  /** Optional context, e.g. "Row Number - 0". API spelling preserved. */
  Paramters?: string | null;
}

/** A single informational entry from the Info envelope. */
export interface CommonInfo {
  ID: number;
  Info: string;
  Paramters?: string | null;
}

/**
 * Response envelope inherited by most objects. Server-generated — never send
 * these fields in requests.
 */
export interface CommonObject {
  /** Business errors. Non-empty means the call failed, even on HTTP 200. */
  Errors: CommonError[];
  Info?: CommonInfo[] | null;
  OpenInfo?: Record<string, string> | null;
}

/** Document type codes (1..10, 13). */
export const DocumentType = {
  Invoice: 1,
  Receipt: 2,
  InvoiceReceipt: 3,
  InvoiceCredit: 4,
  ProformaInvoice: 5,
  InvoiceOrder: 6,
  InvoiceQuote: 7,
  InvoiceShip: 8,
  Deposits: 9,
  SupplierInvoiceToInventory: 10,
  PurchaseOrder: 13,
} as const;

export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

/** Payment type codes (1..9). */
export const PaymentType = {
  CreditCard: 1,
  Check: 2,
  MoneyTransfer: 3,
  Cash: 4,
  Credit: 5,
  WithholdingTax: 6,
  Other: 7,
  Bit: 8,
  PayBox: 9,
} as const;

export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];

/** Document status codes (1..5). */
export const StatusID = {
  Open: 1,
  Closed: 2,
  FullyCredited: 3,
  PartiallyCredited: 4,
  Cancelled: 5,
} as const;

export type StatusID = (typeof StatusID)[keyof typeof StatusID];

/**
 * A line item on a document. `Price`/`Quantity` are floats — convert with
 * money.ts before arithmetic.
 */
export interface DocumentItem {
  Name: string;
  Description?: string | null;
  /** Unit price (float). */
  Price: number;
  /** Price including VAT when TaxIncluded (float). */
  PriceIncludeTax?: number;
  /** Quantity (float). */
  Quantity: number;
  TaxPercentage?: number | null;
  Discount?: Discount | null;
  Code?: string | null;
  LawyerIdentifier?: string | null;
  InventoryId?: number | null;
  WarehouseId?: number | null;
  /** Read-only totals (floats). */
  Total?: number;
  TotalWithoutTax?: number;
  TotalTax?: number;
}

export interface Discount {
  Value: number;
  /** true = fixed amount, false = percent. */
  IsNominal: boolean;
  BeforeTax: boolean;
}

/** A payment attached to a document. `Amount` is a float. */
export interface Payment {
  /** Existing payment ID — used for Deposits documents. */
  ID?: number;
  PaymentType: PaymentType;
  /** Payment amount (float). */
  Amount: number;
  Date?: string | null;
  /** Alternative string date when Date is not set. */
  DateStr?: string | null;
  /** Credit-card installments. */
  NumberOfPayments?: number;
  CreditCardName?: string | null;
  CreditCardType?: number | null;
  /** Check number / last 4 card digits. */
  PaymentNumber?: string | null;
  BankName?: string | null;
  BranchName?: string | null;
  AccountNumber?: string | null;
  PayerID?: string | null;
  ExpirationDate?: string | null;
  /** Sub-type when PaymentType = Other (7). */
  PaymentTypeOtherId?: number;
  PaymentTypeLiteral?: string | null;
}

/** A referenced document in a Receipt — `ReceiptAmount` is a float. */
export interface ReceiptReferenceInvoice {
  ID: string;
  /** Amount allocated from this receipt toward the referenced document (float). */
  ReceiptAmount: number;
}

/** One-off (general) customer for documents without a stored customer record. */
export interface GenerelCustomer {
  ID?: number;
  Name: string;
  /** VAT/ID number. */
  Identifier?: string;
}

export interface AssociatedEmail {
  Mail: string;
  IsUserMail?: boolean;
  ClientId?: number | null;
  IsSendDoc?: boolean | null;
}

/**
 * A document as returned by the API. Totals (`Total`, `TotalWithoutTax`,
 * `TotalTaxAmount`, `Paid`, `CreditAmount`, `Balance`, ...) are floats — convert
 * through money.ts at the boundary.
 */
export interface Document extends CommonObject {
  ID: string;
  /** Legal sequential number, per type. */
  DocumentNumber?: number;
  DocumentType: DocumentType;
  Subject?: string | null;
  ClientID?: number | null;
  GeneralCustomer?: GenerelCustomer | null;
  Items?: DocumentItem[] | null;
  Payments?: Payment[] | null;
  /** Referenced documents (each with ID and ReceiptAmount). Requires DocumentReffType. */
  Invoices?: ReceiptReferenceInvoice[] | null;
  /** Type of the referenced documents. */
  DocumentReffType?: DocumentType | null;
  IssueDate?: string | null;
  Currency?: string | null;
  ConversionRate?: number;
  TaxPercentage?: number | null;
  TaxIncluded?: boolean;
  Discount?: Discount | null;
  BranchID?: number | null;
  /** 1 Hebrew, 2 English. */
  Language?: number;
  AssociatedEmails?: AssociatedEmail[] | null;
  ExternalComments?: string | null;
  InternalComments?: string | null;
  EmailCustomComment?: string | null;
  /** Idempotency key. Auto-generated if missing. */
  ApiIdentifier?: string | null;
  /** Duplicate-detection window in seconds. Default 60. */
  ApiDuplicityTimeValidation?: number;
  PaymentDueDate?: string | null;
  Deduction?: number;
  CloseReceipt?: boolean;
  IsSelfInvoice?: boolean;
  SupplierId?: number | null;
  SupplierName?: string | null;
  UseDecimalValues?: boolean;
  AutoFixPaymentsMismatchItems?: boolean;
  AutoFixMismatchItemName?: string | null;
  StatusID?: StatusID;
  PrintOriginalPDFLink?: string | null;
  PrintCertifiedCopyPDFLink?: string | null;
  CipherText?: string | null;
  CipherTextOriginal?: string | null;
  AllocationNumber?: string | null;
  /** Read-only totals (floats). */
  Total?: number;
  TotalWithoutTax?: number;
  TotalTaxAmount?: number;
  Paid?: number;
  CreditAmount?: number;
  Balance?: number;
}

/**
 * A Receipt (DocumentType 2) request shape. Payments are required; the sum of
 * payments must match the sum of referenced `ReceiptAmount`s unless
 * `CloseReceipt` is set. `DocumentReffType` must be Invoice (1) or
 * ProformaInvoice (5) — Receipt (2) only with `CancelDocument`.
 */
export interface CreateReceiptDoc {
  DocumentType: 2;
  ClientID?: number;
  GeneralCustomer?: GenerelCustomer | null;
  /** Idempotency key — always set it. */
  ApiIdentifier: string;
  /** Required for receipts. `Amount` is a float — convert via money.ts. */
  Payments: Payment[];
  /** Referenced open documents. `ReceiptAmount` is a float. */
  Invoices?: ReceiptReferenceInvoice[];
  /** Type of the referenced documents (Invoice 1 or ProformaInvoice 5). */
  DocumentReffType?: DocumentType;
  Subject?: string;
  IssueDate?: string;
  Currency?: string;
  ConversionRate?: number;
  BranchID?: number;
  Language?: 1 | 2;
  AssociatedEmails?: AssociatedEmail[];
  ExternalComments?: string;
  InternalComments?: string;
  PaymentDueDate?: string;
  /** Skip the payments/references total match check. */
  CloseReceipt?: boolean;
  remarks?: string;
}

/** Filter for GetDocuments — one document type per call. */
export interface DocumentsRequest {
  /** Single document type filter (one type per call). */
  DocumentType?: DocumentType;
  /** Comma-separated list of types, when supported. */
  DocumentTypes?: string | null;
  From?: string | null;
  To?: string | null;
  FromActualCreationDate?: string | null;
  ToActualCreationDate?: string | null;
  FromPaymentDueDate?: string | null;
  ToPaymentDueDate?: string | null;
  Status?: StatusID;
  CustomerID?: number | null;
  CustomerName?: string | null;
  BranchID?: number;
  DocumentNumber?: number;
  ExectDocumentNumber?: number;
  FromNumber?: number | null;
  ToNumber?: number | null;
  /** Total amount range (floats; convert decimal strings via money.ts). */
  FromAmount?: number | null;
  ToAmount?: number | null;
  Currency?: string | null;
  PaymentType?: PaymentType;
  ItemCode?: string | null;
  ItemDescription?: string | null;
  ItemsIncluded?: boolean | null;
  PaymentsIncluded?: boolean | null;
  OnlyGeneralClient?: boolean | null;
  GeneralClientName?: string | null;
  Limit?: number;
}

/** Collection envelope for document searches. */
export interface DocumentCollection extends CommonObject {
  Response: Document[] | null;
}

/** A customer as returned by the API. */
export interface Customer extends CommonObject {
  /** 0/omitted on create; required on update. Negative values are conflict codes. */
  ID: number;
  Name: string;
  /** VAT/company/ID number. Digits only. */
  UniqueID?: string | null;
  Email?: string | null;
  Phone?: string | null;
  Cell?: string | null;
  Fax?: string | null;
  Address?: string | null;
  City?: string | null;
  Zip?: string | null;
  Country?: string | null;
  CountryId?: number | null;
  /** Your external customer number. Unique per organization. */
  ExtNumber?: number | null;
  Active?: boolean;
  /** Payment terms in days (0 = due now, 30 = EOM+30, ...). */
  PayTerms?: number;
  IsNonUniqueNameCreation?: boolean | null;
  Guid?: string | null;
  ClientCode?: string | null;
  /** Read-only reserved balance (float). */
  ReservedBalance?: number;
}

/** Collection envelope for customer searches. */
export interface CustomerCollection extends CommonObject {
  Response: Customer[] | null;
}

export interface CustomerBankDetail {
  ID?: number;
  BankName?: string;
  BranchName?: string;
  BranchNumber?: string;
  AccountNumber?: string;
  AccountType?: string;
  PayingAccount?: boolean;
}

export interface CustomerContact {
  ID?: number;
  Name?: string;
  Email?: string;
  Phone?: string;
  Cell?: string;
  Fax?: string;
  Role?: string;
}

/** Full customer record: base fields plus bank details, contacts, extra emails. */
export interface FullCustomer extends Customer {
  BankDetails?: CustomerBankDetail[] | null;
  Contacts?: CustomerContact[] | null;
  AdditionalEmails?: AssociatedAdditionalEmail[] | null;
}

export interface AssociatedAdditionalEmail {
  Mail?: string;
  IsUserMail?: boolean;
  ClientId?: number | null;
  IsSendDoc?: boolean | null;
}

/** A branch of the organization. */
export interface Branch {
  ID: number;
  Name: string;
  Description?: string | null;
  Enabled: boolean;
  IsDefault: boolean;
  IsMain: boolean;
  Email?: string | null;
}

/** IsAuthenticated result — the authenticated user's identity. */
export interface User extends CommonObject {
  ID: number;
  Email: string;
  OrgID: number;
  ExpirationDate?: string | null;
}
