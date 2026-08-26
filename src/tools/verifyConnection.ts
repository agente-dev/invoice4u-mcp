/**
 * `invoice4u_verify_connection` — verify the API token and report the
 * authenticated organization plus its branches. Pure read; idempotent.
 *
 * Auth failures surface naturally as a structured `authentication_failed`
 * error (the client normalizes invalid tokens / AccountExpired / HTTP errors).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { guardedRead, READ_ANNOTATIONS, type ToolDeps } from "./support.js";

export const VERIFY_CONNECTION_TOOL_NAME = "invoice4u_verify_connection";

export const VERIFY_CONNECTION_DESCRIPTION =
  "Verify the Invoice4U connection and report the authenticated organization " +
  "(userId, email, orgId) and its branches. Read-only.";

export const verifyConnectionInputSchema = {};

export interface VerifyConnectionResult {
  status: "ok";
  environment: "qa" | "production";
  organization: { userId: number; email: string; orgId: number };
  branchCount: number;
  branches: { id: number; name: string; isDefault: boolean }[];
}

export function createVerifyConnectionTool(deps: ToolDeps) {
  return {
    annotations: READ_ANNOTATIONS,
    handler: async (): Promise<CallToolResult> =>
      guardedRead(async () => {
        const user = await deps.client.isAuthenticated();
        const branches = await deps.client.getBranches();

        const data: VerifyConnectionResult = {
          status: "ok",
          environment: deps.config.env,
          organization: { userId: user.ID, email: user.Email, orgId: user.OrgID },
          branchCount: branches.length,
          branches: branches.map((branch) => ({
            id: branch.ID,
            name: branch.Name,
            isDefault: branch.IsDefault,
          })),
        };
        return {
          text: `Connected to Invoice4U (${deps.config.env}) as ${user.Email} — ${branches.length} branch(es).`,
          data,
        };
      }),
  };
}
