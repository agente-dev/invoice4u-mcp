/**
 * Live QA integration smoke test (AGC-781, Train E).
 *
 * Gated by `describe.skipIf(!process.env.INVOICE4U_API_TOKEN)`: with no token
 * the whole suite is skipped and `npm test` stays green at 120 unit/contract
 * tests. When `INVOICE4U_API_TOKEN` IS set (locally or by the github-actions
 * workflow, which also sets INVOICE4U_ENV=qa), this exercises
 * `invoice4u_verify_connection` and `invoice4u_list_branches` against the REAL
 * QA base URL (apiqa.invoice4u.co.il) through the real tools/call path.
 *
 * This is a read-only smoke test only. The full 12-step AGC-781 acceptance
 * (docs/qa-testing.md), including the write steps, requires
 * INVOICE4U_ALLOW_WRITES=true in a throwaway scope and stays MANUAL until
 * real credentials exist.
 */

import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { resolveBaseUrl } from "../../src/config.js";
import { Invoice4uClient } from "../../src/invoice4u/client.js";
import { registerReadTools } from "../../src/server.js";
import type { ToolDeps } from "../../src/tools/support.js";

/** Run only against a live QA token. With none set, this suite is skipped. */
describe.skipIf(!process.env.INVOICE4U_API_TOKEN)("live QA integration", () => {
  async function setup() {
    const token = process.env.INVOICE4U_API_TOKEN as string;
    const baseUrl = resolveBaseUrl("qa");
    const client = new Invoice4uClient({ baseUrl, apiToken: token, timeoutMs: 20_000 });
    const config: Config = {
      apiToken: token,
      env: "qa",
      allowWrites: false,
      logLevel: "error",
      baseUrl,
    };
    const deps: ToolDeps = { client, config };
    const server = new McpServer({ name: "invoice4u-mcp-qa", version: "0.0.0-qa" });
    registerReadTools(server, deps);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new MCPClient({ name: "invoice4u-mcp-qa-client", version: "0.0.0-qa" });
    await mcpClient.connect(clientTransport);
    return { mcpClient };
  }

  async function callTool(
    client: MCPClient,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as unknown as CallToolResult;
  }

  it("invoice4u_verify_connection returns ok against the QA base URL", async () => {
    const { mcpClient } = await setup();
    const result = await callTool(mcpClient, "invoice4u_verify_connection");
    expect(result.isError).toBeFalsy();
    const sc = (result.structuredContent ?? {}) as { status?: string };
    expect(sc.status).toBe("ok");
  });

  it("invoice4u_list_branches returns a branch list against the QA base URL", async () => {
    const { mcpClient } = await setup();
    const result = await callTool(mcpClient, "invoice4u_list_branches");
    expect(result.isError).toBeFalsy();
    const sc = (result.structuredContent ?? {}) as { branches?: unknown[] };
    expect(Array.isArray(sc.branches)).toBe(true);
  });
});
