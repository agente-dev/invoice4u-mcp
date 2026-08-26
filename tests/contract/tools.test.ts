/**
 * Contract tests for the seven read tools (AGC-781 Train C).
 *
 * Every tool is exercised through the real MCP path: an McpServer wired with
 * registerReadTools and a mock client, invoked via `server.server.request`
 * (tools/call). Assertions cover:
 * - happy path: structured content, short human text, normalized output;
 * - error path: an Invoice4uError surfaces as an `isError: true` result with
 *   a structured `{ error: { kind, message, retryable, ... } }` payload — it
 *   is NEVER thrown;
 * - annotations: readOnlyHint true (+ destructive/idempotent/openWorld);
 * - read-only behavior: no client write method is ever called.
 */

import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { Invoice4uClient } from "../../src/invoice4u/client.js";
import { createInvoice4uError } from "../../src/invoice4u/errors.js";
import type { Branch, Customer, Document, FullCustomer, User } from "../../src/invoice4u/types.js";
import { registerReadTools } from "../../src/server.js";
import type { ToolDeps } from "../../src/tools/support.js";

const TOOL_NAMES = [
  "invoice4u_verify_connection",
  "invoice4u_search_documents",
  "invoice4u_get_document",
  "invoice4u_search_customers",
  "invoice4u_get_customer",
  "invoice4u_list_branches",
  "invoice4u_validate_linked_receipt",
] as const;

const CONFIG = {
  apiToken: "test-token",
  env: "qa",
  allowWrites: false,
  logLevel: "info",
  baseUrl: "https://apiqa.invoice4u.co.il/Services/ApiService.svc",
} as Config;

type MockFn = ReturnType<typeof vi.fn>;

/** Every client method a read tool may touch, all non-optional mocks. */
interface ClientMocks {
  isAuthenticated: MockFn;
  getBranches: MockFn;
  getDocument: MockFn;
  getDocumentByNumber: MockFn;
  getDocumentByApiIdentifier: MockFn;
  isDocumentExistsByApiIdentifier: MockFn;
  searchDocuments: MockFn;
  getCustomers: MockFn;
  getCustomersByOrgId: MockFn;
  getCustomerById: MockFn;
  getFullCustomer: MockFn;
  call: MockFn;
  // The only write path in the client layer — must never fire for read tools.
  createDocumentWithIdentifierValidation: MockFn;
}

/** A mock client whose read methods resolve per-test and write methods spy. */
function createMockClient(overrides: Partial<Invoice4uClient> = {}) {
  const client = {
    isAuthenticated: vi.fn(),
    getBranches: vi.fn(),
    getDocument: vi.fn(),
    getDocumentByNumber: vi.fn(),
    getDocumentByApiIdentifier: vi.fn(),
    isDocumentExistsByApiIdentifier: vi.fn(),
    searchDocuments: vi.fn(),
    getCustomers: vi.fn(),
    getCustomersByOrgId: vi.fn(),
    getCustomerById: vi.fn(),
    getFullCustomer: vi.fn(),
    call: vi.fn(),
    createDocumentWithIdentifierValidation: vi.fn(),
    ...overrides,
  } as Invoice4uClient;
  return { client, mocks: client as unknown as ClientMocks };
}

type ToolCallOptions = {
  name: string;
  args?: Record<string, unknown>;
  client: MCPClient;
};

/** Invoke a registered tool through the real tools/call request path. */
async function callTool(options: ToolCallOptions): Promise<CallToolResult> {
  return (await options.client.callTool({
    name: options.name,
    arguments: options.args ?? {},
  })) as unknown as CallToolResult;
}

/** Ask the client for the registered tool list (annotations live there). */
async function listTools(client: MCPClient) {
  const result = await client.listTools();
  return result.tools;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first !== undefined && first.type === "text") return first.text;
  return "";
}

interface ConnectedHarness {
  server: McpServer;
  mcpClient: MCPClient;
  mocks: ClientMocks;
  names: string[];
}

/**
 * Wire registerReadTools to a real McpServer + Client over an in-memory
 * transport, so every test exercises the true protocol path (including the
 * SDK's input-schema validation).
 */
async function trackedSetup(overrides: Partial<Invoice4uClient> = {}): Promise<ConnectedHarness> {
  const { client: mockClient, mocks } = createMockClient(overrides);
  const deps: ToolDeps = { client: mockClient, config: CONFIG };
  const server = new McpServer({ name: "invoice4u-mcp-test", version: "0.0.0-test" });
  const names = registerReadTools(server, deps);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new MCPClient({ name: "invoice4u-mcp-test-client", version: "0.0.0-test" });
  await mcpClient.connect(clientTransport);
  const harness = { server, mcpClient, mocks, names };
  harnesses.push(harness);
  return harness;
}

function authError(op = "GetBranches") {
  return createInvoice4uError("authentication_failed", {
    message: `${op} failed: UnauthorizedUser (80)`,
    op,
    code: 80,
  });
}

function sampleBranch(id: number, name: string): Branch {
  return {
    ID: id,
    Name: name,
    Enabled: true,
    IsDefault: id === 1,
    IsMain: id === 1,
    Email: id === 1 ? "main@example.com" : null,
  };
}

function sampleUser(): User {
  return { ID: 7, Email: "ops@example.com", OrgID: 42, Errors: [] };
}

function sampleDocument(overrides: Partial<Document> = {}): Document {
  return {
    ID: "inv-111",
    DocumentNumber: 1001,
    DocumentType: 1,
    StatusID: 1,
    Subject: "Monthly services",
    IssueDate: "2026-08-01T00:00:00",
    Currency: "ILS",
    Total: 117.0,
    TotalWithoutTax: 100.0,
    TotalTaxAmount: 17.0,
    ClientID: 88231,
    GeneralCustomer: null,
    BranchID: 5,
    Payments: [
      {
        PaymentType: 4,
        Amount: 117.0,
        Date: "2026-08-01T00:00:00",
        PaymentNumber: "1234",
      },
    ],
    Invoices: [{ ID: "inv-other", ReceiptAmount: 30.0 }],
    DocumentReffType: 2,
    ApiIdentifier: "order-10045",
    PrintOriginalPDFLink: "https://newviewqa.invoice4u.co.il/d/abc",
    PrintCertifiedCopyPDFLink: null,
    Errors: [],
    ...overrides,
  };
}

function sampleCustomer(): Customer {
  return {
    ID: 88231,
    Name: "Acme Ltd",
    Email: "billing@acme.test",
    City: "Tel Aviv",
    Phone: "03-1234567",
    Errors: [],
  };
}

function sampleFullCustomer(): FullCustomer {
  return {
    ID: 88231,
    Name: "Acme Ltd",
    Email: "billing@acme.test",
    Phone: "03-1234567",
    Cell: "050-1112223",
    Fax: null,
    Address: "1 Main St",
    City: "Tel Aviv",
    Zip: "12345",
    Country: "IL",
    ExtNumber: 77,
    ClientCode: "ext-acme",
    BankDetails: [
      { BankName: "Hapoalim", BranchNumber: "12", AccountNumber: "4567", PayingAccount: true },
      { BankName: "Leumi", BranchNumber: "99", AccountNumber: "0001", PayingAccount: false },
    ],
    Errors: [],
  };
}

const INVOICE_A = "11111111-1111-4111-8111-111111111111";
const INVOICE_B = "22222222-2222-4222-8222-222222222222";

function openInvoice(
  id: string,
  total: number,
  balance: number | undefined,
  paidRefs: { ID: string; ReceiptAmount: number }[] = [],
): Document {
  return {
    ID: id,
    DocumentNumber: id === INVOICE_A ? 5001 : 5002,
    DocumentType: 1,
    StatusID: 1,
    Total: total,
    Balance: balance,
    Invoices: paidRefs,
    DocumentReffType: 2,
    Currency: "ILS",
    Errors: [],
  };
}

const harnesses: ConnectedHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.mcpClient.close();
    await harness.server.close();
  }
  vi.restoreAllMocks();
});

describe("tool registration surface", () => {
  it("registers exactly the seven read tools with read-only annotations", async () => {
    const { mcpClient, names } = await trackedSetup();
    expect(names).toEqual([...TOOL_NAMES]);
    const tools = await listTools(mcpClient);
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(true);
    }
  });
});

describe("invoice4u_verify_connection", () => {
  it("reports organization and branches on success", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.isAuthenticated.mockResolvedValue(sampleUser());
    mocks.getBranches.mockResolvedValue([sampleBranch(1, "Main"), sampleBranch(2, "North")]);

    const result = await callTool({ client: mcpClient, name: "invoice4u_verify_connection" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      environment: "qa",
      organization: { userId: 7, email: "ops@example.com", orgId: 42 },
      branchCount: 2,
      branches: [
        { id: 1, name: "Main", isDefault: true },
        { id: 2, name: "North", isDefault: false },
      ],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("turns an auth error into a structured error result (never throws)", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.isAuthenticated.mockRejectedValue(authError("IsAuthenticated"));

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_verify_connection",
    })) as CallToolResult & {
      isError: true;
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        kind: "authentication_failed",
        retryable: false,
        message: expect.stringContaining("IsAuthenticated"),
      },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });
});

describe("invoice4u_search_documents", () => {
  const args = {
    documentType: "invoice",
    fromDate: "2026-06-01",
    customerId: 88231,
    status: "open",
    minAmount: "10.50",
    maxAmount: "500.00",
    exactDocumentNumber: 1001,
  };

  it("searches with the mapped wire filter and normalizes results", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.searchDocuments.mockResolvedValue([sampleDocument()]);

    const result = await callTool({ client: mcpClient, name: "invoice4u_search_documents", args });

    expect(mocks.searchDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        DocumentType: 1,
        Status: 1,
        CustomerID: 88231,
        From: "2026-06-01T00:00:00",
        FromAmount: 10.5,
        ToAmount: 500,
        ExectDocumentNumber: 1001,
        ItemsIncluded: false,
        PaymentsIncluded: false,
        Limit: 50,
      }),
    );
    expect(result.structuredContent).toMatchObject({
      documents: [
        {
          documentId: "inv-111",
          documentNumber: 1001,
          documentType: "invoice",
          status: "open",
          issueDate: "2026-08-01T00:00:00",
          total: "117.00",
          currency: "ILS",
          customerId: 88231,
        },
      ],
      count: 1,
    });
    expect(result.structuredContent).not.toHaveProperty("pageInfo");
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("defaults the limit and flags hasMoreData when count hits the limit", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    const docs = Array.from({ length: 50 }, (_, index) =>
      sampleDocument({ ID: `inv-${index}`, DocumentNumber: 1000 + index }),
    );
    mocks.searchDocuments.mockResolvedValue(docs);

    const result = await callTool({
      client: mcpClient,
      name: "invoice4u_search_documents",
      args: { documentType: "receipt" },
    });

    expect(mocks.searchDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ DocumentType: 2, Limit: 50 }),
    );
    expect(result.structuredContent).toMatchObject({ count: 50, pageInfo: { hasMoreData: true } });
  });

  it("surfaces an auth failure as a structured error", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.searchDocuments.mockRejectedValue(authError("GetDocuments"));

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_search_documents",
      args: { documentType: "proforma" },
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { kind: "authentication_failed", retryable: false },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });
});

describe("invoice4u_get_document", () => {
  it("fetches and fully normalizes a document by GUID", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocument.mockResolvedValue(sampleDocument());

    const result = await callTool({
      client: mcpClient,
      name: "invoice4u_get_document",
      args: { documentId: "7f6a2c1e-8b4d-4f2a-9c3e-0d1e2f3a4b5c" },
    });

    expect(mocks.getDocument).toHaveBeenCalledWith("7f6a2c1e-8b4d-4f2a-9c3e-0d1e2f3a4b5c");
    expect(mocks.getDocumentByNumber).not.toHaveBeenCalled();
    expect(mocks.getDocumentByApiIdentifier).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      documentId: "inv-111",
      documentNumber: 1001,
      documentType: "invoice",
      status: "open",
      subject: "Monthly services",
      issueDate: "2026-08-01T00:00:00",
      dueDate: undefined,
      currency: "ILS",
      total: "117.00",
      totalWithoutTax: "100.00",
      totalTax: "17.00",
      customer: { id: 88231, name: undefined },
      branchId: 5,
      payments: [
        {
          method: { code: 4, name: "cash" },
          amount: "117.00",
          date: "2026-08-01T00:00:00",
          reference: "1234",
        },
      ],
      linkedInvoices: [{ documentId: "inv-other", allocatedAmount: "30.00" }],
      apiIdentifier: "order-10045",
      pdf: { original: "https://newviewqa.invoice4u.co.il/d/abc", certifiedCopy: undefined },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("looks up by documentNumber + documentType", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocumentByNumber.mockResolvedValue(sampleDocument());

    const result = await callTool({
      client: mcpClient,
      name: "invoice4u_get_document",
      args: { documentNumber: 1001, documentType: "invoice" },
    });

    expect(mocks.getDocumentByNumber).toHaveBeenCalledWith(1001, 1);
    expect(mocks.getDocument).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ documentId: "inv-111" });
  });

  it("looks up by apiIdentifier", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.call.mockResolvedValue(sampleDocument());

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_get_document",
      args: { apiIdentifier: "order-10045" },
    })) as CallToolResult;

    expect(mocks.call).toHaveBeenCalledWith(
      "GetDocumentByApiIdentifier",
      { apiIdentifier: "order-10045" },
      "GetDocumentByApiIdentifierResult",
    );
    expect(mocks.getDocument).not.toHaveBeenCalled();
    expect(mocks.getDocumentByNumber).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ apiIdentifier: "order-10045" });
  });

  it("scopes an apiIdentifier lookup with documentType when provided", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.call.mockResolvedValue(sampleDocument());

    await callTool({
      client: mcpClient,
      name: "invoice4u_get_document",
      args: { apiIdentifier: "order-10045", documentType: "quote" },
    });

    expect(mocks.call).toHaveBeenCalledWith(
      "GetDocumentByApiIdentifier",
      { apiIdentifier: "order-10045", docType: 7 },
      "GetDocumentByApiIdentifierResult",
    );
  });

  it("surfaces an input-validation error when zero or multiple strategies are supplied", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    // In this SDK version malformed tool input is answered with an isError
    // result (the message carries the refine text) rather than a thrown error.
    const empty = (await callTool({
      client: mcpClient,
      name: "invoice4u_get_document",
      args: {},
    })) as CallToolResult & { isError: true };
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain("Exactly one lookup strategy");

    const multiple = (await callTool({
      client: mcpClient,
      name: "invoice4u_get_document",
      args: { documentId: "7f6a2c1e-8b4d-4f2a-9c3e-0d1e2f3a4b5c", apiIdentifier: "order-10045" },
    })) as CallToolResult & { isError: true };
    expect(multiple.isError).toBe(true);
    expect(textOf(multiple)).toContain("Exactly one lookup strategy");

    const numberOnly = (await callTool({
      client: mcpClient,
      name: "invoice4u_get_document",
      args: { documentNumber: 1001 },
    })) as CallToolResult & { isError: true };
    expect(numberOnly.isError).toBe(true);
    expect(textOf(numberOnly)).toContain("Exactly one lookup strategy");

    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("surfaces a document-not-found failure as a structured error", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocument.mockRejectedValue(
      createInvoice4uError("document_not_found", {
        message: "GetDocument failed: DocumentNotFound (321)",
        op: "GetDocument",
        code: 321,
      }),
    );

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_get_document",
      args: { documentId: "7f6a2c1e-8b4d-4f2a-9c3e-0d1e2f3a4b5c" },
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { kind: "document_not_found", retryable: false },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });
});

describe("invoice4u_search_customers", () => {
  it("filters by name/email and truncates to the limit", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getCustomers.mockResolvedValue([
      sampleCustomer(),
      { ...sampleCustomer(), ID: 88232, Name: "Acme Europe", City: null },
      { ...sampleCustomer(), ID: 88233, Name: "Acme Asia", Phone: null },
    ]);

    const result = await callTool({
      client: mcpClient,
      name: "invoice4u_search_customers",
      args: { name: "Acme", limit: 2 },
    });

    expect(mocks.getCustomers).toHaveBeenCalledWith({ Name: "Acme" });
    expect(result.structuredContent).toMatchObject({
      customers: [
        {
          customerId: 88231,
          name: "Acme Ltd",
          email: "billing@acme.test",
          city: "Tel Aviv",
          phone: "03-1234567",
        },
        { customerId: 88232, name: "Acme Europe" },
      ],
      count: 2,
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("surfaces an auth failure as a structured error", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getCustomers.mockRejectedValue(authError("GetCustomers"));

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_search_customers",
      args: { email: "billing@acme.test" },
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { kind: "authentication_failed", retryable: false },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });
});

describe("invoice4u_get_customer", () => {
  it("normalizes the full customer record", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getFullCustomer.mockResolvedValue(sampleFullCustomer());

    const result = await callTool({
      client: mcpClient,
      name: "invoice4u_get_customer",
      args: { customerId: 88231 },
    });

    expect(mocks.getFullCustomer).toHaveBeenCalledWith(88231);
    expect(result.structuredContent).toMatchObject({
      id: 88231,
      name: "Acme Ltd",
      email: "billing@acme.test",
      phones: ["03-1234567", "050-1112223"],
      address: { street: "1 Main St", city: "Tel Aviv", zipcode: "12345", country: "IL" },
      bank: { name: "Hapoalim", branch: "12", account: "4567" },
      externalNumber: 77,
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("surfaces a customer-not-found failure as a structured error", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getFullCustomer.mockRejectedValue(
      createInvoice4uError("document_not_found", {
        message: "GetFullCustomer failed: CustomerNotFound (136)",
        op: "GetFullCustomer",
        code: 136,
      }),
    );

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_get_customer",
      args: { customerId: 99999 },
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { kind: "document_not_found", retryable: false },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });
});

describe("invoice4u_list_branches", () => {
  it("lists branches with flags", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getBranches.mockResolvedValue([sampleBranch(1, "Main"), sampleBranch(2, "North")]);

    const result = await callTool({ client: mcpClient, name: "invoice4u_list_branches" });

    expect(result.structuredContent).toMatchObject({
      branches: [
        {
          id: 1,
          name: "Main",
          enabled: true,
          isDefault: true,
          isMain: true,
          email: "main@example.com",
        },
        { id: 2, name: "North", enabled: true, isDefault: false, isMain: false, email: undefined },
      ],
      count: 2,
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("surfaces an auth failure (null result / bad token) as a structured error", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getBranches.mockRejectedValue(authError("GetBranches"));

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_list_branches",
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { kind: "authentication_failed", retryable: false },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });
});

describe("invoice4u_validate_linked_receipt", () => {
  it("validates a linked receipt against two invoices (deduped fetch, mixed payments)", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocument.mockImplementation((id: string) => {
      if (id === INVOICE_A) return Promise.resolve(openInvoice(INVOICE_A, 100, 60));
      if (id === INVOICE_B)
        return Promise.resolve(
          openInvoice(INVOICE_B, 200, undefined, [{ ID: "receipt-1", ReceiptAmount: 50 }]),
        );
      return Promise.reject(new Error(`unexpected id ${id}`));
    });

    const result = await callTool({
      client: mcpClient,
      name: "invoice4u_validate_linked_receipt",
      args: {
        apiIdentifier: "receipt-preflight-1",
        clientId: 88231,
        paymentDate: "2026-08-05",
        payments: [
          { method: "cash", amount: "110.00" },
          { method: "bank_transfer", amount: "150.00" },
        ],
        invoiceAllocations: [
          { invoiceDocumentId: INVOICE_A, amount: "60.00" },
          { invoiceDocumentId: INVOICE_B, amount: "150.00" },
          { invoiceDocumentId: INVOICE_B, amount: "50.00" },
        ],
      },
    });

    // INVOICE_B referenced twice but fetched once (dedupe).
    expect(mocks.getDocument).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({
      valid: true,
      invoices: [
        {
          documentId: INVOICE_A,
          documentNumber: 5001,
          currentBalance: "60.00",
          allocation: "60.00",
        },
        {
          documentId: INVOICE_B,
          documentNumber: 5002,
          currentBalance: "150.00",
          allocation: "150.00",
        },
        {
          documentId: INVOICE_B,
          documentNumber: 5002,
          currentBalance: "150.00",
          allocation: "50.00",
        },
      ],
      totalPayments: "260.00",
      totalAllocations: "260.00",
      currency: "ILS",
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("rejects with invoice_not_open when a referenced invoice is not open", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocument.mockResolvedValue({ ...openInvoice(INVOICE_A, 100, 60, []), StatusID: 5 });

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_validate_linked_receipt",
      args: {
        apiIdentifier: "receipt-preflight-2",
        clientId: 88231,
        paymentDate: "2026-08-05",
        payments: [{ method: "cash", amount: "60.00" }],
        invoiceAllocations: [{ invoiceDocumentId: INVOICE_A, amount: "60.00" }],
      },
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        kind: "invoice_not_open",
        retryable: false,
        details: { invoices: [{ documentId: INVOICE_A, status: 5 }] },
      },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("rejects with allocation_exceeds_balance when an allocation exceeds the open balance", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocument.mockResolvedValue(openInvoice(INVOICE_A, 100, 60));

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_validate_linked_receipt",
      args: {
        apiIdentifier: "receipt-preflight-3",
        clientId: 88231,
        paymentDate: "2026-08-05",
        payments: [{ method: "cash", amount: "70.00" }],
        invoiceAllocations: [{ invoiceDocumentId: INVOICE_A, amount: "70.00" }],
      },
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        kind: "allocation_exceeds_balance",
        details: {
          invoice: { documentId: INVOICE_A, allocation: "70.00", balance: "60.00" },
        },
      },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("rejects with a validation error when payments != allocations", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocument.mockResolvedValue(openInvoice(INVOICE_A, 100, 60));

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_validate_linked_receipt",
      args: {
        apiIdentifier: "receipt-preflight-4",
        clientId: 88231,
        paymentDate: "2026-08-05",
        payments: [{ method: "cash", amount: "59.99" }],
        invoiceAllocations: [{ invoiceDocumentId: INVOICE_A, amount: "60.00" }],
      },
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        kind: "invoice4u_validation_error",
        details: { totalPayments: "59.99", totalAllocations: "60.00" },
      },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("rejects with document_not_found listing the missing ids", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocument.mockImplementation((id: string) => {
      if (id === INVOICE_A) return Promise.resolve(openInvoice(INVOICE_A, 100, 60));
      return Promise.reject(
        createInvoice4uError("document_not_found", {
          message: `GetDocument failed: ApiDocumentDoesNotExistForUser (321)`,
          op: "GetDocument",
          code: 321,
        }),
      );
    });

    const result = (await callTool({
      client: mcpClient,
      name: "invoice4u_validate_linked_receipt",
      args: {
        apiIdentifier: "receipt-preflight-5",
        clientId: 88231,
        paymentDate: "2026-08-05",
        payments: [{ method: "cash", amount: "60.00" }],
        invoiceAllocations: [
          { invoiceDocumentId: INVOICE_A, amount: "30.00" },
          { invoiceDocumentId: INVOICE_B, amount: "30.00" },
        ],
      },
    })) as CallToolResult & { isError: true };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        kind: "document_not_found",
        retryable: false,
        details: { documentIds: [INVOICE_B] },
      },
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("never performs a write even when every check passes", async () => {
    const { mcpClient, mocks } = await trackedSetup();
    mocks.getDocument.mockResolvedValue(openInvoice(INVOICE_A, 100, 60));

    const result = await callTool({
      client: mcpClient,
      name: "invoice4u_validate_linked_receipt",
      args: {
        apiIdentifier: "receipt-preflight-6",
        clientId: 88231,
        paymentDate: "2026-08-05",
        payments: [
          { method: "cash", amount: "50.00" },
          { method: "check", amount: "10.00" },
        ],
        invoiceAllocations: [{ invoiceDocumentId: INVOICE_A, amount: "60.00" }],
      },
    });

    expect(result.structuredContent).toMatchObject({ valid: true });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });
});
