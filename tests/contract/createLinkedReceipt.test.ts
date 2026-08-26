/**
 * Contract tests for the write tool of AGC-781, Train D:
 * `invoice4u_create_linked_receipt` and its write-gating in registerWriteTools.
 *
 * Exercises the real MCP path: an McpServer wired with registerReadTools +
 * registerWriteTools and a mock client, invoked via tools/call. Covers:
 * - happy path → status created + full verification block;
 * - duplicate (134 + DocumentNumber > 0) → already_exists, exactly 1 create, no retry;
 * - validation failures (not-open, over-allocation, mismatched totals) →
 *   validation_failed, 0 create calls;
 * - network timeout → identifier-lookup-found → resolved via lookup (1 create, no retry);
 * - network timeout → lookup document_not_found → single retry with the SAME
 *   apiIdentifier (2 create calls);
 * - post-write re-fetch failure → verification_failed;
 * - registerWriteTools gating: allowWrites=false registers nothing; allowWrites=true
 *   registers exactly one tool with the write annotations (readOnlyHint false,
 *   idempotentHint true, destructiveHint false).
 */

import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { Invoice4uClient } from "../../src/invoice4u/client.js";
import { createInvoice4uError } from "../../src/invoice4u/errors.js";
import type { Document } from "../../src/invoice4u/types.js";
import { registerReadTools, registerWriteTools } from "../../src/server.js";
import type { ToolDeps } from "../../src/tools/support.js";

type MockFn = ReturnType<typeof vi.fn>;

interface ClientMocks {
  getDocument: MockFn;
  getDocumentByApiIdentifier: MockFn;
  getDocumentByNumber: MockFn;
  searchDocuments: MockFn;
  getCustomersByOrgId: MockFn;
  getCustomers: MockFn;
  getCustomerById: MockFn;
  getFullCustomer: MockFn;
  isAuthenticated: MockFn;
  getBranches: MockFn;
  call: MockFn;
  createDocumentWithIdentifierValidation: MockFn;
}

const WRITE_CONFIG: Config = {
  apiToken: "test-token",
  env: "qa",
  allowWrites: true,
  logLevel: "info",
  baseUrl: "https://apiqa.invoice4u.co.il/Services/ApiService.svc",
};

const READONLY_CONFIG: Config = { ...WRITE_CONFIG, allowWrites: false };

function createMockClient(overrides: Partial<Invoice4uClient> = {}) {
  const client = {
    getDocument: vi.fn(),
    getDocumentByApiIdentifier: vi.fn(),
    getDocumentByNumber: vi.fn(),
    searchDocuments: vi.fn(),
    getCustomersByOrgId: vi.fn(),
    getCustomers: vi.fn(),
    getCustomerById: vi.fn(),
    getFullCustomer: vi.fn(),
    isAuthenticated: vi.fn(),
    getBranches: vi.fn(),
    call: vi.fn(),
    createDocumentWithIdentifierValidation: vi.fn(),
    ...overrides,
  } as unknown as Invoice4uClient;
  return { client, mocks: client as unknown as ClientMocks };
}

const TOOL_NAME = "invoice4u_create_linked_receipt";

const READ_TOOLS = [
  "invoice4u_verify_connection",
  "invoice4u_search_documents",
  "invoice4u_get_document",
  "invoice4u_search_customers",
  "invoice4u_get_customer",
  "invoice4u_list_branches",
  "invoice4u_validate_linked_receipt",
] as const;

const INVOICE_A = "11111111-1111-4111-8111-111111111111";
const INVOICE_B = "22222222-2222-4222-8222-222222222222";

interface Harness {
  server: McpServer;
  mcpClient: MCPClient;
  mocks: ClientMocks;
  readNames: string[];
  writeNames: string[];
}

const harnesses: Harness[] = [];

async function setup(allowWrites = true): Promise<Harness> {
  const config = allowWrites ? WRITE_CONFIG : READONLY_CONFIG;
  const { client, mocks } = createMockClient();
  const deps: ToolDeps = { client, config };
  const server = new McpServer({ name: "invoice4u-mcp-test", version: "0.0.0-test" });
  const readNames = registerReadTools(server, deps);
  const writeNames = registerWriteTools(server, deps);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new MCPClient({ name: "invoice4u-mcp-test-client", version: "0.0.0-test" });
  await mcpClient.connect(clientTransport);
  const harness = { server, mcpClient, mocks, readNames, writeNames };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.mcpClient.close();
    await harness.server.close();
  }
  vi.restoreAllMocks();
});

async function callTool(tool: MCPClient, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await tool.callTool({ name: TOOL_NAME, arguments: args })) as unknown as CallToolResult;
}

async function listTools(tool: MCPClient) {
  return (await tool.listTools()).tools;
}

function openInvoice(
  id: string,
  total: number,
  balance: number,
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

function receiptDoc(id: string, documentNumber: number, total: number): Document {
  return {
    ID: id,
    DocumentNumber: documentNumber,
    DocumentType: 2,
    StatusID: 2,
    ClientID: 88231,
    Total: total,
    ApiIdentifier: "receipt-arg",
    Errors: [],
  };
}

function networkError(message = "CreateDocumentWithIdentifierValidation timed out after 15000ms") {
  return createInvoice4uError("network_error", {
    message,
    op: "CreateDocumentWithIdentifierValidation",
    code: 147,
  });
}

const HAPPY_ARGS = {
  apiIdentifier: "receipt-arg",
  clientId: 88231,
  paymentDate: "2026-08-05",
  payments: [
    { method: "cash", amount: "60.00" },
    { method: "bank_transfer", amount: "50.00" },
  ],
  invoiceAllocations: [
    { invoiceDocumentId: INVOICE_A, amount: "60.00" },
    { invoiceDocumentId: INVOICE_B, amount: "50.00" },
  ],
};

describe("registerWriteTools gating", () => {
  it("registers NOTHING when allowWrites is false", async () => {
    const { mcpClient, writeNames, readNames } = await setup(false);
    expect(writeNames).toEqual([]);
    expect(readNames).toEqual([...READ_TOOLS]);
    const tools = await listTools(mcpClient);
    expect(tools.map((tool) => tool.name)).toEqual([...READ_TOOLS]);
    expect(tools.some((tool) => tool.name === TOOL_NAME)).toBe(false);
  });

  it("registers exactly one tool with write annotations when allowWrites is true", async () => {
    const { mcpClient, writeNames, readNames } = await setup(true);
    expect(writeNames).toEqual([TOOL_NAME]);
    expect(readNames).toEqual([...READ_TOOLS]);
    const tools = await listTools(mcpClient);
    expect(tools.filter((tool) => tool.name === TOOL_NAME)).toHaveLength(1);
    const write = tools.find((tool) => tool.name === TOOL_NAME);
    expect(write?.annotations?.readOnlyHint).toBe(false);
    expect(write?.annotations?.destructiveHint).toBe(false);
    expect(write?.annotations?.idempotentHint).toBe(true);
    expect(write?.annotations?.openWorldHint).toBe(true);
  });
});

describe("invoice4u_create_linked_receipt", () => {
  it("happy path → status created with a full verification block", async () => {
    const { mcpClient, mocks } = await setup();
    // Preflight fetches invoices A,B before the write; post-create re-fetch
    // (calls 3,4) returns the reduced balances.
    const pre = {
      [INVOICE_A]: openInvoice(INVOICE_A, 100, 60),
      [INVOICE_B]: openInvoice(INVOICE_B, 200, 150),
    };
    const post = {
      [INVOICE_A]: openInvoice(INVOICE_A, 100, 0),
      [INVOICE_B]: openInvoice(INVOICE_B, 200, 100),
    };
    let getCalls = 0;
    mocks.getDocument.mockImplementation((id: string) => {
      getCalls += 1;
      const stage = getCalls <= 2 ? pre : post;
      return Promise.resolve(stage[id as keyof typeof stage]);
    });
    mocks.getDocumentByApiIdentifier.mockResolvedValue(receiptDoc("receipt-1", 9001, 110.0));
    mocks.createDocumentWithIdentifierValidation.mockResolvedValue(
      receiptDoc("receipt-1", 9001, 110.0),
    );

    const result = await callTool(mcpClient, HAPPY_ARGS);

    expect(result.isError).toBeUndefined();
    expect(mocks.createDocumentWithIdentifierValidation).toHaveBeenCalledTimes(1);
    expect(mocks.createDocumentWithIdentifierValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        DocumentType: 2,
        ClientID: 88231,
        ApiIdentifier: "receipt-arg",
        DocumentReffType: 1,
        Payments: [
          { PaymentType: 4, Amount: 60, Date: "2026-08-05" },
          { PaymentType: 3, Amount: 50, Date: "2026-08-05" },
        ],
        Invoices: [
          { ID: INVOICE_A, ReceiptAmount: 60 },
          { ID: INVOICE_B, ReceiptAmount: 50 },
        ],
      }),
    );
    expect(result.structuredContent).toMatchObject({
      status: "created",
      receipt: {
        receiptId: "receipt-1",
        documentNumber: 9001,
        apiIdentifier: "receipt-arg",
        total: "110.00",
      },
      invoices: [
        {
          documentId: INVOICE_A,
          documentNumber: 5001,
          previousBalance: "60.00",
          newBalance: "0.00",
          status: 1,
        },
        {
          documentId: INVOICE_B,
          documentNumber: 5002,
          previousBalance: "150.00",
          newBalance: "100.00",
          status: 1,
        },
      ],
      verification: { receiptFetched: true, invoicesReFetched: true, balancesConsistent: true },
    });
    expect(getCalls).toBe(4);
  });

  it("duplicate (134 + DocumentNumber>0) → already_exists, exactly 1 create (no retry)", async () => {
    const { mcpClient, mocks } = await setup();
    mocks.getDocument.mockImplementation((id: string) =>
      Promise.resolve(
        id === INVOICE_A ? openInvoice(INVOICE_A, 100, 60) : openInvoice(INVOICE_B, 200, 150),
      ),
    );
    mocks.getDocumentByApiIdentifier.mockResolvedValue(receiptDoc("receipt-existing", 9001, 110.0));
    mocks.createDocumentWithIdentifierValidation.mockRejectedValue(
      createInvoice4uError("duplicate_api_identifier", {
        message: "CreateDocumentWithIdentifierValidation failed: DocumentAlreadyCreated (134)",
        op: "CreateDocumentWithIdentifierValidation",
        code: 134,
      }),
    );

    const result = await callTool(mcpClient, HAPPY_ARGS);

    expect(mocks.createDocumentWithIdentifierValidation).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      status: "already_exists",
      receipt: { receiptId: "receipt-existing", documentNumber: 9001, total: "110.00" },
      verification: { balancesConsistent: true },
    });
  });

  it("rejects with validation_failed (invoice_not_open) and does not write", async () => {
    const { mcpClient, mocks } = await setup();
    mocks.getDocument.mockResolvedValue({ ...openInvoice(INVOICE_A, 100, 60), StatusID: 5 });

    const result = await callTool(mcpClient, {
      ...HAPPY_ARGS,
      payments: [{ method: "cash", amount: "10.00" }],
      invoiceAllocations: [{ invoiceDocumentId: INVOICE_A, amount: "10.00" }],
    });

    expect(result.structuredContent).toMatchObject({
      status: "validation_failed",
      failures: [{ kind: "invoice_not_open" }],
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("rejects with validation_failed (allocation_exceeds_balance) and does not write", async () => {
    const { mcpClient, mocks } = await setup();
    mocks.getDocument.mockResolvedValue(openInvoice(INVOICE_A, 100, 60));

    const result = await callTool(mcpClient, {
      ...HAPPY_ARGS,
      payments: [{ method: "cash", amount: "70.00" }],
      invoiceAllocations: [{ invoiceDocumentId: INVOICE_A, amount: "70.00" }],
    });

    expect(result.structuredContent).toMatchObject({
      status: "validation_failed",
      failures: [{ kind: "allocation_exceeds_balance" }],
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("rejects with validation_failed (mismatched totals) and does not write", async () => {
    const { mcpClient, mocks } = await setup();
    mocks.getDocument.mockResolvedValue(openInvoice(INVOICE_A, 100, 60));

    const result = await callTool(mcpClient, {
      ...HAPPY_ARGS,
      payments: [{ method: "cash", amount: "59.99" }],
      invoiceAllocations: [{ invoiceDocumentId: INVOICE_A, amount: "60.00" }],
    });

    expect(result.structuredContent).toMatchObject({
      status: "validation_failed",
      failures: [{ kind: "invoice4u_validation_error" }],
    });
    expect(mocks.createDocumentWithIdentifierValidation).not.toHaveBeenCalled();
  });

  it("timeout → identifier-lookup found → resolved via lookup (1 create, no retry)", async () => {
    const { mcpClient, mocks } = await setup();
    const pre = {
      [INVOICE_A]: openInvoice(INVOICE_A, 100, 60),
      [INVOICE_B]: openInvoice(INVOICE_B, 200, 150),
    };
    const post = {
      [INVOICE_A]: openInvoice(INVOICE_A, 100, 0),
      [INVOICE_B]: openInvoice(INVOICE_B, 200, 100),
    };
    let getCalls = 0;
    mocks.getDocument.mockImplementation((id: string) => {
      getCalls += 1;
      const stage = getCalls <= 2 ? pre : post;
      return Promise.resolve(stage[id as keyof typeof stage]);
    });
    mocks.getDocumentByApiIdentifier.mockResolvedValue(receiptDoc("receipt-1", 9001, 110.0));
    mocks.createDocumentWithIdentifierValidation.mockRejectedValueOnce(networkError());

    const result = await callTool(mcpClient, HAPPY_ARGS);

    // 1 create (the timeout one) + a successful recovery lookup; no retry create.
    expect(mocks.createDocumentWithIdentifierValidation).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      status: "created",
      receipt: { receiptId: "receipt-1" },
    });
  });

  it("timeout → lookup document_not_found → single retry with the SAME apiIdentifier (2 creates)", async () => {
    const { mcpClient, mocks } = await setup();
    const pre = {
      [INVOICE_A]: openInvoice(INVOICE_A, 100, 60),
      [INVOICE_B]: openInvoice(INVOICE_B, 200, 150),
    };
    const post = {
      [INVOICE_A]: openInvoice(INVOICE_A, 100, 0),
      [INVOICE_B]: openInvoice(INVOICE_B, 200, 100),
    };
    let getCalls = 0;
    mocks.getDocument.mockImplementation((id: string) => {
      getCalls += 1;
      const stage = getCalls <= 2 ? pre : post;
      return Promise.resolve(stage[id as keyof typeof stage]);
    });
    // First lookup (recovery after the timeout) proves absent; the later
    // step-9 receipt re-fetch resolves.
    mocks.getDocumentByApiIdentifier
      .mockRejectedValueOnce(
        createInvoice4uError("document_not_found", {
          message: "GetDocumentByApiIdentifier failed (321)",
          op: "GetDocumentByApiIdentifier",
          code: 321,
        }),
      )
      .mockResolvedValue(receiptDoc("receipt-1", 9001, 110.0));
    mocks.createDocumentWithIdentifierValidation
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(receiptDoc("receipt-1", 9001, 110.0));

    const result = await callTool(mcpClient, HAPPY_ARGS);

    expect(mocks.createDocumentWithIdentifierValidation).toHaveBeenCalledTimes(2);
    expect(mocks.createDocumentWithIdentifierValidation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ApiIdentifier: "receipt-arg" }),
    );
    expect(mocks.createDocumentWithIdentifierValidation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ApiIdentifier: "receipt-arg" }),
    );
    expect(result.structuredContent).toMatchObject({
      status: "created",
      receipt: { receiptId: "receipt-1" },
    });
  });

  it("post-write re-fetch failure → verification_failed (receipt still reported)", async () => {
    const { mcpClient, mocks } = await setup();
    const pre = {
      [INVOICE_A]: openInvoice(INVOICE_A, 100, 60),
      [INVOICE_B]: openInvoice(INVOICE_B, 200, 150),
    };
    let getCalls = 0;
    mocks.getDocument.mockImplementation((id: string) => {
      getCalls += 1;
      if (getCalls <= 2) return Promise.resolve(pre[id as keyof typeof pre]);
      return Promise.reject(networkError("re-fetch failed"));
    });
    mocks.createDocumentWithIdentifierValidation.mockResolvedValue(
      receiptDoc("receipt-1", 9001, 110.0),
    );

    const result = await callTool(mcpClient, HAPPY_ARGS);

    expect(mocks.createDocumentWithIdentifierValidation).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      status: "verification_failed",
      receipt: { receiptId: "receipt-1", documentNumber: 9001, total: "110.00" },
      verification: { receiptFetched: false, invoicesReFetched: false, balancesConsistent: false },
    });
  });
});
