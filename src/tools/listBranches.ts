/**
 * `invoice4u_list_branches` — all branches of the organization. Pure read;
 * idempotent.
 *
 * Note: per the verified API reference, GetBranches returns `null` on
 * auth/server failure — the client already converts that into a structured
 * `authentication_failed` error, which surfaces unchanged.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { guardedRead, READ_ANNOTATIONS, type ToolDeps } from "./support.js";

export const LIST_BRANCHES_TOOL_NAME = "invoice4u_list_branches";

export const LIST_BRANCHES_DESCRIPTION =
  "List all branches of the organization with their flags (enabled, " +
  "default, main) and contact email. Read-only.";

export const listBranchesInputSchema = {};

export interface ListBranchesBranch {
  id: number;
  name: string;
  description?: string;
  enabled: boolean;
  isDefault: boolean;
  isMain: boolean;
  email?: string;
}

export interface ListBranchesResult {
  branches: ListBranchesBranch[];
  count: number;
}

export function createListBranchesTool(deps: ToolDeps) {
  return {
    annotations: READ_ANNOTATIONS,
    handler: async (): Promise<CallToolResult> =>
      guardedRead(async () => {
        const branches = await deps.client.getBranches();
        const data: ListBranchesResult = {
          branches: branches.map((branch) => ({
            id: branch.ID,
            name: branch.Name,
            description: branch.Description ?? undefined,
            enabled: branch.Enabled,
            isDefault: branch.IsDefault,
            isMain: branch.IsMain,
            email: branch.Email ?? undefined,
          })),
          count: branches.length,
        };
        return {
          text: `${branches.length} branch(es): ${branches.map((branch) => branch.Name).join(", ")}.`,
          data,
        };
      }),
  };
}
