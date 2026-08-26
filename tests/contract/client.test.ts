import { describe, expect, it } from "vitest";
import { Invoice4uClient } from "../../src/invoice4u/client.js";
import { Invoice4uErrorImpl } from "../../src/invoice4u/errors.js";
import type {
  Branch,
  CreateReceiptDoc,
  Customer,
  Document,
  DocumentsRequest,
} from "../../src/invoice4u/types.js";
import { DocumentType, PaymentType } from "../../src/invoice4u/types.js";

const BASE_URL = "https://apiqa.invoice4u.co.il/Services/ApiService.svc";
const TOKEN = "org-secret-token-123456";

interface FetchCall {
  url: string;
  init: RequestInit;
}

type FetchHandler = (url: string, init: RequestInit) => unknown;

function jsonResponse(body: unknown, status = 200): unknown {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(handler: FetchHandler): { client: Invoice4uClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return (await handler(url, init ?? {})) as Response;
  };
  const client = new Invoice4uClient({ baseUrl: BASE_URL, apiToken: TOKEN, fetchImpl });
  return { client, calls };
}

async function captureError(promise: Promise<unknown>): Promise<Invoice4uErrorImpl> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Invoice4uErrorImpl) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

function sampleBranch(): Branch {
  return { ID: 1, Name: "Main", Enabled: true, IsDefault: true, IsMain: true };
}

function sampleDoc(id: string): Document {
  return { ID: id, DocumentType: 1, Errors: [] };
}

const sampleDr: DocumentsRequest = {
  DocumentType: DocumentType.Invoice,
  From: "2026-06-01T00:00:00",
  CustomerID: 88231,
  ItemsIncluded: true,
};

const sampleCustomer: Customer = { ID: 88231, Name: "Acme Ltd", Errors: [] };

describe("wrapped request envelope", () => {
  it("POSTs wrapped params and token to the op URL", async () => {
    const { client, calls } = setup(() => jsonResponse({ GetDocumentResult: sampleDoc("doc-1") }));
    const doc = await client.getDocument("7f6a2c1e-8b4d-4f2a-9c3e-0d1e2f3a4b5c");
    const call = calls[0];
    expect(call?.url).toBe(`${BASE_URL}/GetDocument`);
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("Content-Type")).toContain("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      docId: "7f6a2c1e-8b4d-4f2a-9c3e-0d1e2f3a4b5c",
      token: TOKEN,
    });
    expect(doc.ID).toBe("doc-1");
  });

  it("sends the dr filter as a wrapped param", async () => {
    const { client, calls } = setup(() =>
      jsonResponse({ GetDocumentsResult: { Response: [], Errors: [] } }),
    );
    await client.searchDocuments(sampleDr);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.dr).toEqual(sampleDr);
    expect(body.token).toBe(TOKEN);
  });
});

describe("result-key unwrapping", () => {
  it("unwraps GetDocumentsResult.Response", async () => {
    const { client } = setup(() =>
      jsonResponse({
        GetDocumentsResult: { Response: [sampleDoc("a"), sampleDoc("b")], Errors: [] },
      }),
    );
    const docs = await client.searchDocuments(sampleDr);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.ID).toBe("a");
    expect(docs[1]?.ID).toBe("b");
  });

  it("treats a null Response as an empty success list", async () => {
    const { client } = setup(() =>
      jsonResponse({ GetCustomersByOrgIdResult: { Response: null, Errors: [] } }),
    );
    await expect(client.getCustomersByOrgId()).resolves.toEqual([]);
  });

  it("resolves a boolean result (IsDocumentExistsByApiIdentifier)", async () => {
    const { client, calls } = setup(() =>
      jsonResponse({ IsDocumentExistsByApiIdentifierResult: true }),
    );
    await expect(client.isDocumentExistsByApiIdentifier("order-10045")).resolves.toBe(true);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ apiIdentifier: "order-10045", token: TOKEN });
  });
});

describe("Errors envelope normalization (HTTP 200 + Errors = failure)", () => {
  it("maps 80 → authentication_failed", async () => {
    const { client } = setup(() =>
      jsonResponse({
        GetBranchesResult: [],
        Errors: [{ ID: 80, Error: "UnauthorizedUser" }],
      }),
    );
    const error = await captureError(client.getBranches());
    expect(error.kind).toBe("authentication_failed");
    expect(error.retryable).toBe(false);
    expect(error.apiErrors?.[0]?.ID).toBe(80);
    expect(error.op).toBe("GetBranches");
  });

  it("maps 134 → duplicate_api_identifier (nested in the result envelope)", async () => {
    const { client } = setup(() =>
      jsonResponse({
        GetDocumentsResult: {
          Response: [sampleDoc("existing")],
          Errors: [{ ID: 134, Error: "DocumentAlreadyCreated" }],
        },
      }),
    );
    const error = await captureError(client.searchDocuments(sampleDr));
    expect(error.kind).toBe("duplicate_api_identifier");
    expect(error.retryable).toBe(false);
    expect(error.code).toBe(134);
  });

  it("maps 50 → allocation_exceeds_balance", async () => {
    const { client } = setup(() =>
      jsonResponse({
        GetDocumentResult: {
          ID: "inv-1",
          DocumentType: 2,
          Errors: [{ ID: 50, Error: "DocumentReceiptAmountOutOfRange" }],
        },
      }),
    );
    const error = await captureError(client.getDocument("inv-1"));
    expect(error.kind).toBe("allocation_exceeds_balance");
    expect(error.retryable).toBe(false);
  });

  it("maps 49 → invoice_not_open", async () => {
    const { client } = setup(() =>
      jsonResponse({
        GetDocumentResult: {
          ID: "inv-1",
          DocumentType: 2,
          Errors: [{ ID: 49, Error: "DocumentStatusInValid" }],
        },
      }),
    );
    const error = await captureError(client.getDocument("inv-1"));
    expect(error.kind).toBe("invoice_not_open");
    expect(error.retryable).toBe(false);
  });

  it("never treats a payload as success when Errors is non-empty", async () => {
    const { client } = setup(() =>
      jsonResponse({
        GetDocumentResult: {
          ...sampleDoc("doc-1"),
          Total: 117,
          Errors: [{ ID: 80, Error: "UnauthorizedUser" }],
        },
      }),
    );
    const error = await captureError(client.getDocument("doc-1"));
    expect(error.kind).toBe("authentication_failed");
  });
});

describe("null results", () => {
  it("GetBranches null result → authentication_failed (ref: null = auth/server error)", async () => {
    const { client } = setup(() => jsonResponse({ GetBranchesResult: null }));
    const error = await captureError(client.getBranches());
    expect(error.kind).toBe("authentication_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("GetBranches");
  });
});

describe("network failures", () => {
  it("AbortError → retryable network_error, retried twice (3 attempts)", async () => {
    const { client, calls } = setup(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const error = await captureError(client.getBranches());
    expect(error.kind).toBe("network_error");
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(3);
    expect(error.message).not.toContain(TOKEN);
  });

  it("recovers when an aborted read succeeds on retry", async () => {
    let attempts = 0;
    const { client } = setup(() => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("The operation was aborted.", "AbortError");
      return jsonResponse({ GetBranchesResult: [sampleBranch()] });
    });
    await expect(client.getBranches()).resolves.toEqual([sampleBranch()]);
    expect(attempts).toBe(2);
  });

  it("read ops retry twice on network_error and then succeed", async () => {
    let attempts = 0;
    const { client, calls } = setup(() => {
      attempts += 1;
      if (attempts <= 2) throw new TypeError("fetch failed");
      return jsonResponse({ GetBranchesResult: [sampleBranch()] });
    });
    await expect(client.getBranches()).resolves.toEqual([sampleBranch()]);
    expect(calls).toHaveLength(3);
  });

  it("5xx → retryable network_error with httpStatus, still retried", async () => {
    const { client, calls } = setup(() => jsonResponse({}, 500));
    const error = await captureError(client.getBranches());
    expect(error.kind).toBe("network_error");
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBe(500);
    expect(calls).toHaveLength(3);
  });
});

describe("writes never retry", () => {
  const receiptDoc: CreateReceiptDoc = {
    DocumentType: 2,
    ApiIdentifier: "receipt-1",
    Payments: [{ PaymentType: PaymentType.Cash, Amount: 10 }],
    Invoices: [{ ID: "inv-1", ReceiptAmount: 10 }],
    DocumentReffType: DocumentType.Invoice,
  };

  it("createDocumentWithIdentifierValidation does NOT retry on network error (1 call)", async () => {
    const { client, calls } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const error = await captureError(client.createDocumentWithIdentifierValidation(receiptDoc));
    expect(error.kind).toBe("network_error");
    expect(error.retryable).toBe(true); // still reported as retryable for the caller to decide
    expect(calls).toHaveLength(1);
  });

  it("Create-prefixed ops never retry even without the write flag", async () => {
    const { client, calls } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const error = await captureError(
      client.call("CreateSomething", { x: 1 }, "CreateSomethingResult"),
    );
    expect(error.kind).toBe("network_error");
    expect(calls).toHaveLength(1);
  });

  it("sends the doc and token in the write body", async () => {
    const { client, calls } = setup(() =>
      jsonResponse({
        CreateDocumentWithIdentifierValidationResult: { ...sampleDoc("new"), Errors: [] },
      }),
    );
    const created = await client.createDocumentWithIdentifierValidation(receiptDoc);
    expect(created.ID).toBe("new");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.token).toBe(TOKEN);
    expect((body.doc as Record<string, unknown>).DocumentType).toBe(2);
    expect((body.doc as Record<string, unknown>).ApiIdentifier).toBe("receipt-1");
  });
});

describe("token safety", () => {
  it("redacts the token from server error text before throwing", async () => {
    const { client } = setup(() =>
      jsonResponse({
        GetBranchesResult: [],
        Errors: [{ ID: 80, Error: `UnauthorizedUser ${TOKEN}` }],
      }),
    );
    const error = await captureError(client.getBranches());
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).toContain("GetBranches");
    expect(error.code).toBe(80);
  });
});

describe("unexpected responses", () => {
  it("HTTP 404 → unexpected_response with httpStatus, no retry", async () => {
    const { client, calls } = setup(() => jsonResponse({}, 404));
    const error = await captureError(client.getBranches());
    expect(error.kind).toBe("unexpected_response");
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("non-JSON body → unexpected_response", async () => {
    const { client } = setup(() => new Response("<html>gateway error</html>", { status: 200 }));
    const error = await captureError(client.getBranches());
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toContain("not valid JSON");
  });

  it("a missing result key → unexpected_response", async () => {
    const { client } = setup(() => jsonResponse({ SomeOtherEnvelope: [] }));
    const error = await captureError(client.getBranches());
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toContain("GetBranchesResult");
  });
});

describe("typed read methods", () => {
  it("searchCustomers-style collection methods unwrap their Response", async () => {
    const { client } = setup(() =>
      jsonResponse({
        GetCustomersResult: { Response: [sampleCustomer], Errors: [] },
      }),
    );
    await expect(client.getCustomers({ Name: "Acme" })).resolves.toEqual([sampleCustomer]);
  });

  it("getCustomerById unwraps the customer envelope", async () => {
    const { client } = setup(() =>
      jsonResponse({ GetCustomerByIdResult: { ...sampleCustomer, Errors: [] } }),
    );
    await expect(client.getCustomerById(88231)).resolves.toMatchObject({ ID: 88231 });
  });

  it("getFullCustomer passes orgID 0", async () => {
    const { client, calls } = setup(() =>
      jsonResponse({ GetFullCustomerResult: { ...sampleCustomer, Errors: [] } }),
    );
    await client.getFullCustomer(88231);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ id: 88231, orgID: 0, token: TOKEN });
  });

  it("isAuthenticated unwraps the User envelope", async () => {
    const { client } = setup(() =>
      jsonResponse({
        IsAuthenticatedResult: { ID: 7, Email: "ops@example.com", OrgID: 42, Errors: [] },
      }),
    );
    await expect(client.isAuthenticated()).resolves.toMatchObject({
      OrgID: 42,
      Email: "ops@example.com",
    });
  });
});
