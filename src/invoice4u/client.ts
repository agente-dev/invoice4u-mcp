/**
 * Invoice4uClient — the single sanctioned way to talk to the Invoice4U API.
 *
 * Wire protocol (verified 2026-08-26):
 * - WCF wrapped POST to `${baseUrl}/${op}` with `{ ...params, token }` as JSON.
 * - Response is `{ "<Op>Result": ... }`. Business failures come back as
 *   HTTP 200 with a non-empty `Errors` array inside the envelope — the client
 *   normalizes that into a typed `Invoice4uError` on EVERY call; a non-empty
 *   Errors array is NEVER treated as success. `Errors` is checked both at the
 *   top level of the body and on the unwrapped result object.
 * - Network exceptions, HTTP 5xx and abort/timeout failures normalize to
 *   `network_error` (retryable). Read calls retry up to 2 times with
 *   exponential backoff; writes (ops starting with "Create", or any call with
 *   `write: true`) are NEVER retried automatically.
 *
 * The API token is sent in the request body only — never in URLs or logs — and
 * is redacted from any thrown error message before it escapes.
 */

import { fromApiErrors, Invoice4uErrorImpl } from "./errors.js";
import type {
  Branch,
  CommonError,
  CreateReceiptDoc,
  Customer,
  CustomerCollection,
  Document,
  DocumentCollection,
  DocumentsRequest,
  DocumentType,
  FullCustomer,
  User,
} from "./types.js";

export interface Invoice4uClientConfig {
  /** Allowlisted base URL, e.g. https://apiqa.invoice4u.co.il/Services/ApiService.svc */
  baseUrl: string;
  /** Organization API key. Never logged, never in thrown errors. */
  apiToken: string;
  /** Injectable fetch for tests. Defaults to the global fetch (Node >= 24). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Defaults to 15s. */
  timeoutMs?: number;
}

export interface CallOptions {
  /**
   * Treat this call as a write: never auto-retry on network errors. Ops whose
   * name starts with "Create" are always treated as writes even without this
   * flag.
   */
  readonly write?: boolean;
}

/** Bound on automatic retries for reads (network_error only). */
export const MAX_NETWORK_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 100;
const DEFAULT_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCommonError(value: unknown): value is CommonError {
  return isRecord(value) && typeof value.ID === "number" && typeof value.Error === "string";
}

/** Collect deduplicated CommonError[] from any number of candidate objects. */
function collectErrors(...candidates: unknown[]): CommonError[] {
  const out: CommonError[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !Array.isArray(candidate.Errors)) continue;
    for (const entry of candidate.Errors) {
      if (!isCommonError(entry)) continue;
      if (!out.some((existing) => existing.ID === entry.ID && existing.Error === entry.Error)) {
        out.push({ ID: entry.ID, Error: entry.Error, Paramters: entry.Paramters });
      }
    }
  }
  return out;
}

function isAbortError(error: unknown): boolean {
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export class Invoice4uClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: Invoice4uClientConfig) {
    if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
      throw new TypeError("Invoice4uClient: baseUrl is required");
    }
    if (typeof config.apiToken !== "string" || config.apiToken.trim() === "") {
      throw new TypeError("Invoice4uClient: apiToken is required");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiToken = config.apiToken;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Core call: POST `{ ...params, token }` to `${baseUrl}/${op}`, unwrap the
   * `<op>Result` envelope key (pass it explicitly, e.g. "GetDocumentsResult"),
   * and normalize the Errors envelope into a typed `Invoice4uError` on failure.
   *
   * Reads retry up to `MAX_NETWORK_RETRIES` on `network_error` only; writes
   * (op starts with "Create", or `options.write`) never retry.
   */
  async call<T>(
    op: string,
    params: Record<string, unknown>,
    resultKey?: string,
    options: CallOptions = {},
  ): Promise<T> {
    const isWrite = options.write === true || op.startsWith("Create");
    let attempt = 0;
    for (;;) {
      try {
        return await this.callOnce<T>(op, params, resultKey);
      } catch (error) {
        if (!(error instanceof Invoice4uErrorImpl)) throw error;
        error.redact(this.apiToken);
        if (!isWrite && error.kind === "network_error" && attempt < MAX_NETWORK_RETRIES) {
          attempt += 1;
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      }
    }
  }

  /** Single HTTP attempt — never retries, always normalizes failures. */
  private async callOnce<T>(
    op: string,
    params: Record<string, unknown>,
    resultKey?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}/${op}`;
    const body = JSON.stringify({ ...params, token: this.apiToken });

    let response: Response;
    let rawText: string;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      rawText = await response.text();
    } catch (error) {
      const reason = isAbortError(error)
        ? `request to ${op} timed out after ${this.timeoutMs}ms`
        : `network error calling ${op}`;
      throw new Invoice4uErrorImpl({
        kind: "network_error",
        retryable: true,
        message: reason,
        op,
        code: 147,
      });
    }

    if (response.status >= 500) {
      throw new Invoice4uErrorImpl({
        kind: "network_error",
        retryable: true,
        message: `server error (HTTP ${response.status}) calling ${op}`,
        httpStatus: response.status,
        op,
      });
    }
    if (!response.ok) {
      throw new Invoice4uErrorImpl({
        kind: "unexpected_response",
        retryable: false,
        message: `unexpected HTTP ${response.status} calling ${op}`,
        httpStatus: response.status,
        op,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Invoice4uErrorImpl({
        kind: "unexpected_response",
        retryable: false,
        message: `response from ${op} was not valid JSON`,
        op,
      });
    }

    if (!isRecord(parsed)) {
      throw new Invoice4uErrorImpl({
        kind: "unexpected_response",
        retryable: false,
        message: `response from ${op} was not a JSON object`,
        op,
      });
    }

    let result: unknown = parsed;
    if (resultKey !== undefined) {
      if (!(resultKey in parsed)) {
        throw new Invoice4uErrorImpl({
          kind: "unexpected_response",
          retryable: false,
          message: `response from ${op} did not contain "${resultKey}"`,
          op,
        });
      }
      result = parsed[resultKey];
    }

    // Normalize the Errors envelope on EVERY call — it wins over any payload.
    const apiErrors = collectErrors(parsed, result);
    if (apiErrors.length > 0) {
      throw fromApiErrors(apiErrors, { op });
    }

    if (result === null || result === undefined) {
      // Verified reference: GetBranches-style ops return null on auth/server
      // failure with an empty Errors array — surface it as authentication_failed.
      throw new Invoice4uErrorImpl({
        kind: "authentication_failed",
        retryable: false,
        message: `${op} returned a null result (invalid token or server-side error)`,
        op,
      });
    }

    return result as T;
  }

  // --- Thin typed methods ---------------------------------------------------

  /** Verify the token: POST /IsAuthenticated → User. */
  isAuthenticated(): Promise<User> {
    return this.call<User>("IsAuthenticated", {}, "IsAuthenticatedResult");
  }

  /** List branches: POST /GetBranches → Branch[]. Null results throw. */
  getBranches(): Promise<Branch[]> {
    return this.call<Branch[]>("GetBranches", {}, "GetBranchesResult");
  }

  /** Get a document by GUID: POST /GetDocument. */
  getDocument(id: string): Promise<Document> {
    return this.call<Document>("GetDocument", { docId: id }, "GetDocumentResult");
  }

  /** Get a document by sequential number (numbers are per type). */
  getDocumentByNumber(num: number, type: DocumentType): Promise<Document> {
    return this.call<Document>(
      "GetDocumentByNumber",
      { docNumber: num, documentType: type },
      "GetDocumentByNumberResult",
    );
  }

  /** Recovery path: get a document by its idempotency key and type. */
  getDocumentByApiIdentifier(id: string, docType: DocumentType): Promise<Document> {
    return this.call<Document>(
      "GetDocumentByApiIdentifier",
      { apiIdentifier: id, docType },
      "GetDocumentByApiIdentifierResult",
    );
  }

  /** Existence check for an idempotency key. */
  isDocumentExistsByApiIdentifier(id: string): Promise<boolean> {
    return this.call<boolean>(
      "IsDocumentExistsByApiIdentifier",
      { apiIdentifier: id },
      "IsDocumentExistsByApiIdentifierResult",
    );
  }

  /** Filtered document search (one DocumentType per call). */
  async searchDocuments(dr: DocumentsRequest): Promise<Document[]> {
    const result = await this.call<DocumentCollection>(
      "GetDocuments",
      { dr },
      "GetDocumentsResult",
    );
    return result.Response ?? [];
  }

  /** All customers of the organization. */
  async getCustomersByOrgId(): Promise<Customer[]> {
    const result = await this.call<CustomerCollection>(
      "GetCustomersByOrgId",
      {},
      "GetCustomersByOrgIdResult",
    );
    return result.Response ?? [];
  }

  /** Filtered customer search — any subset of Customer fields as filter. */
  async getCustomers(filter: Partial<Customer>): Promise<Customer[]> {
    const result = await this.call<CustomerCollection>(
      "GetCustomers",
      { cust: filter },
      "GetCustomersResult",
    );
    return result.Response ?? [];
  }

  /** Get one customer by ID. */
  getCustomerById(id: number): Promise<Customer> {
    return this.call<Customer>("GetCustomerById", { custId: id }, "GetCustomerByIdResult");
  }

  /** Full customer record (bank details, contacts, extra emails). */
  getFullCustomer(id: number): Promise<FullCustomer> {
    return this.call<FullCustomer>("GetFullCustomer", { id, orgID: 0 }, "GetFullCustomerResult");
  }

  /**
   * Idempotent create: POST /CreateDocumentWithIdentifierValidation. Duplicate
   * ApiIdentifier surfaces as `duplicate_api_identifier` (134) — a write, so
   * never auto-retried.
   */
  createDocumentWithIdentifierValidation(doc: CreateReceiptDoc | Document): Promise<Document> {
    return this.call<Document>(
      "CreateDocumentWithIdentifierValidation",
      { doc },
      "CreateDocumentWithIdentifierValidationResult",
      { write: true },
    );
  }
}
