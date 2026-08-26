/**
 * Server wiring for the Invoice4U MCP read surface (Train C).
 *
 * `registerReadTools` registers the seven read tools of AGC-781 on an
 * `McpServer` instance. Each tool:
 * - carries read-only annotations (readOnlyHint: true, destructiveHint: false,
 *   idempotentHint: true, openWorldHint: true);
 * - returns a short human text plus `structuredContent`;
 * - converts expected API failures into `isError: true` results carrying
 *   `{ error: { kind, message, retryable, apiErrors?, details? } }` — it
 *   never throws for expected failures (malformed input is rejected by the
 *   SDK's input validation with an `McpError` before any handler runs).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createGetCustomerTool,
  GET_CUSTOMER_DESCRIPTION,
  GET_CUSTOMER_TOOL_NAME,
  getCustomerInputSchema,
} from "./tools/getCustomer.js";
import {
  createGetDocumentTool,
  GET_DOCUMENT_DESCRIPTION,
  GET_DOCUMENT_TOOL_NAME,
  getDocumentInputSchemaRegistered,
} from "./tools/getDocument.js";
import {
  createListBranchesTool,
  LIST_BRANCHES_DESCRIPTION,
  LIST_BRANCHES_TOOL_NAME,
  listBranchesInputSchema,
} from "./tools/listBranches.js";
import {
  createSearchCustomersTool,
  SEARCH_CUSTOMERS_DESCRIPTION,
  SEARCH_CUSTOMERS_TOOL_NAME,
  searchCustomersInputSchema,
} from "./tools/searchCustomers.js";
import {
  createSearchDocumentsTool,
  SEARCH_DOCUMENTS_DESCRIPTION,
  SEARCH_DOCUMENTS_TOOL_NAME,
  searchDocumentsInputSchema,
} from "./tools/searchDocuments.js";
import type { ToolDeps } from "./tools/support.js";
import {
  createValidateLinkedReceiptTool,
  VALIDATE_LINKED_RECEIPT_DESCRIPTION,
  VALIDATE_LINKED_RECEIPT_TOOL_NAME,
  validateLinkedReceiptInputSchema,
} from "./tools/validateLinkedReceipt.js";
import {
  createVerifyConnectionTool,
  VERIFY_CONNECTION_DESCRIPTION,
  VERIFY_CONNECTION_TOOL_NAME,
  verifyConnectionInputSchema,
} from "./tools/verifyConnection.js";

/** The one annotation set every read tool is registered with. */
export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

interface ReadToolRegistration {
  name: string;
  description: string;
  /** A zod raw shape or refined object schema — validated by the SDK. */
  inputSchema: unknown;
  /** Accepts any per-tool handler; the SDK validates args before calling. */
  handler: (args: never) => Promise<CallToolResult>;
}

function buildRegistrations(deps: ToolDeps): ReadToolRegistration[] {
  return [
    {
      name: VERIFY_CONNECTION_TOOL_NAME,
      description: VERIFY_CONNECTION_DESCRIPTION,
      inputSchema: verifyConnectionInputSchema,
      handler: createVerifyConnectionTool(deps).handler,
    },
    {
      name: SEARCH_DOCUMENTS_TOOL_NAME,
      description: SEARCH_DOCUMENTS_DESCRIPTION,
      inputSchema: searchDocumentsInputSchema,
      handler: createSearchDocumentsTool(deps).handler,
    },
    {
      name: GET_DOCUMENT_TOOL_NAME,
      description: GET_DOCUMENT_DESCRIPTION,
      // Registered as the refined object (not a raw shape) so the exactly-one-
      // strategy rule is enforced by the SDK's input validation.
      inputSchema: getDocumentInputSchemaRegistered,
      handler: createGetDocumentTool(deps).handler,
    },
    {
      name: SEARCH_CUSTOMERS_TOOL_NAME,
      description: SEARCH_CUSTOMERS_DESCRIPTION,
      inputSchema: searchCustomersInputSchema,
      handler: createSearchCustomersTool(deps).handler,
    },
    {
      name: GET_CUSTOMER_TOOL_NAME,
      description: GET_CUSTOMER_DESCRIPTION,
      inputSchema: getCustomerInputSchema,
      handler: createGetCustomerTool(deps).handler,
    },
    {
      name: LIST_BRANCHES_TOOL_NAME,
      description: LIST_BRANCHES_DESCRIPTION,
      inputSchema: listBranchesInputSchema,
      handler: createListBranchesTool(deps).handler,
    },
    {
      name: VALIDATE_LINKED_RECEIPT_TOOL_NAME,
      description: VALIDATE_LINKED_RECEIPT_DESCRIPTION,
      inputSchema: validateLinkedReceiptInputSchema,
      handler: createValidateLinkedReceiptTool(deps).handler,
    },
  ];
}

/**
 * Register all seven read tools on the server. Returns the registered tool
 * names (useful for tests and for gating the future write tools).
 */
export function registerReadTools(server: McpServer, deps: ToolDeps): string[] {
  const names: string[] = [];
  for (const registration of buildRegistrations(deps)) {
    server.registerTool(
      registration.name,
      {
        description: registration.description,
        // All input schemas are zod raw shapes; the SDK validates arguments
        // against them before invoking the handler. The casts bypass the
        // generic inference so one registration loop serves every tool.
        inputSchema: registration.inputSchema as never,
        annotations: READ_TOOL_ANNOTATIONS,
      },
      ((args: unknown) => registration.handler(args as never)) as unknown as Parameters<
        typeof server.registerTool
      >[2],
    );
    names.push(registration.name);
  }
  return names;
}
