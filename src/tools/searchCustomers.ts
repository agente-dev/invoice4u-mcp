/**
 * `invoice4u_search_customers` — filtered customer search. Pure read;
 * idempotent.
 *
 * The primary path is GetCustomers with a partial Customer filter ({Name},
 * {Email}); results are truncated client-side to the requested limit.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Customer } from "../invoice4u/types.js";
import { guardedRead, READ_ANNOTATIONS, type ToolDeps } from "./support.js";

export const SEARCH_CUSTOMERS_TOOL_NAME = "invoice4u_search_customers";

export const SEARCH_CUSTOMERS_DESCRIPTION =
  "Search customers by name (contains) and/or email. Returns matching " +
  "customers with contact summary. Read-only.";

export const searchCustomersInputSchema = {
  name: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  limit: z.number().int().min(1).max(250).default(50),
};

export const searchCustomersInputObject = z.object(searchCustomersInputSchema);
export type SearchCustomersInput = z.infer<typeof searchCustomersInputObject>;

export interface SearchCustomerSummary {
  customerId: number;
  name: string;
  email?: string;
  city?: string;
  phone?: string;
}

export interface SearchCustomersResult {
  customers: SearchCustomerSummary[];
  count: number;
}

function summarize(customer: Customer): SearchCustomerSummary {
  return {
    customerId: customer.ID,
    name: customer.Name,
    email: customer.Email ?? undefined,
    city: customer.City ?? undefined,
    phone: customer.Phone ?? customer.Cell ?? undefined,
  };
}

export function createSearchCustomersTool(deps: ToolDeps) {
  return {
    annotations: READ_ANNOTATIONS,
    handler: async (args: SearchCustomersInput): Promise<CallToolResult> =>
      guardedRead(async () => {
        const filter: Partial<Customer> = {};
        if (args.name !== undefined) filter.Name = args.name;
        if (args.email !== undefined) filter.Email = args.email;

        const customers = await deps.client.getCustomers(filter);
        const truncated = customers.slice(0, args.limit);
        const data: SearchCustomersResult = {
          customers: truncated.map(summarize),
          count: truncated.length,
        };
        return {
          text:
            `Found ${truncated.length} customer(s) matching the filter` +
            (customers.length > truncated.length
              ? ` (showing first ${truncated.length} of ${customers.length})`
              : "") +
            ".",
          data,
        };
      }),
  };
}
