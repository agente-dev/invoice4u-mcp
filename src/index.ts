import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ConfigError } from "./config.js";
import { loadConfig } from "./config.js";

export const VERSION = "0.1.0-rc.0";

function reportConfigErrors(errors: ConfigError[]): void {
  process.stderr.write("invoice4u-mcp: invalid configuration:\n");
  for (const error of errors) {
    process.stderr.write(`  - ${error.field}: ${error.message}\n`);
  }
}

async function main(): Promise<void> {
  const result = loadConfig(process.env);
  if (!result.ok) {
    reportConfigErrors(result.errors);
    process.exit(1);
  }

  // result.config is fully validated and ready for Train B, which builds the
  // Invoice4U client from it and registers the tool surface:
  //   invoice4u_verify_connection, invoice4u_search_documents,
  //   invoice4u_get_document, invoice4u_search_customers, invoice4u_get_customer,
  //   invoice4u_list_branches, invoice4u_validate_linked_receipt, and
  //   invoice4u_create_linked_receipt (write, gated by config.allowWrites).

  const server = new McpServer({
    name: "invoice4u-mcp",
    version: VERSION,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `invoice4u-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
