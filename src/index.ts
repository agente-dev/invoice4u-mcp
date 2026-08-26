import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ConfigError } from "./config.js";
import { loadConfig } from "./config.js";
import { Invoice4uClient } from "./invoice4u/client.js";
import { registerReadTools } from "./server.js";

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
  const config = result.config;

  // Read surface (Train C): the seven read tools of AGC-781. Write tools
  // (invoice4u_create_linked_receipt etc.) are registered later, gated by
  // config.allowWrites.
  const client = new Invoice4uClient({
    baseUrl: config.baseUrl,
    apiToken: config.apiToken,
  });

  const server = new McpServer({
    name: "invoice4u-mcp",
    version: VERSION,
  });

  registerReadTools(server, { client, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `invoice4u-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
