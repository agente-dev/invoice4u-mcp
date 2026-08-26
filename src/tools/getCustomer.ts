/**
 * `invoice4u_get_customer` — full customer record (bank details, contacts).
 * Pure read; idempotent.
 *
 * Fetches via GetFullCustomer and normalizes to a flat snake_case shape.
 * Phones are gathered from Phone/Cell/Fax; bank details come from the
 * customer's PayingAccount entry (falling back to the first entry).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { FullCustomer } from "../invoice4u/types.js";
import { guardedRead, READ_ANNOTATIONS, type ToolDeps } from "./support.js";

export const GET_CUSTOMER_TOOL_NAME = "invoice4u_get_customer";

export const GET_CUSTOMER_DESCRIPTION =
  "Get one full customer record by customerId, including bank details, " +
  "phones and address. Read-only.";

export const getCustomerInputSchema = {
  customerId: z.number().int().positive(),
};

export const getCustomerInputObject = z.object(getCustomerInputSchema);
export type GetCustomerInput = z.infer<typeof getCustomerInputObject>;

export interface GetCustomerResult {
  id: number;
  name: string;
  email?: string;
  phones: string[];
  address?: { street?: string; city?: string; zipcode?: string; country?: string };
  bank?: { name?: string; branch?: string; account?: string };
  externalNumber?: number;
  externalReference?: string;
  notes?: string;
}

function normalizeCustomer(customer: FullCustomer): GetCustomerResult {
  const result: GetCustomerResult = {
    id: customer.ID,
    name: customer.Name,
    email: customer.Email ?? undefined,
    phones: [customer.Phone, customer.Cell, customer.Fax].filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    ),
  };

  if (
    (customer.Address !== null && customer.Address !== undefined) ||
    (customer.City !== null && customer.City !== undefined) ||
    (customer.Zip !== null && customer.Zip !== undefined) ||
    (customer.Country !== null && customer.Country !== undefined)
  ) {
    result.address = {
      street: customer.Address ?? undefined,
      city: customer.City ?? undefined,
      zipcode: customer.Zip ?? undefined,
      country: customer.Country ?? undefined,
    };
  }

  const bankDetails =
    customer.BankDetails === null || customer.BankDetails === undefined ? [] : customer.BankDetails;
  const paying = bankDetails.find((entry) => entry.PayingAccount === true) ?? bankDetails[0];
  if (paying !== undefined) {
    result.bank = {
      name: paying.BankName ?? undefined,
      branch: paying.BranchName ?? paying.BranchNumber ?? undefined,
      account: paying.AccountNumber ?? undefined,
    };
  }

  if (customer.ExtNumber !== null && customer.ExtNumber !== undefined) {
    result.externalNumber = customer.ExtNumber;
  }
  if (
    customer.ClientCode !== null &&
    customer.ClientCode !== undefined &&
    customer.ClientCode !== ""
  ) {
    result.externalReference = customer.ClientCode;
  }
  // The verified wire types carry no free-text notes field; `notes` stays
  // unset unless the API starts exposing one (see types.ts).

  return result;
}

export function createGetCustomerTool(deps: ToolDeps) {
  return {
    annotations: READ_ANNOTATIONS,
    handler: async (args: GetCustomerInput): Promise<CallToolResult> =>
      guardedRead(async () => {
        const customer = await deps.client.getFullCustomer(args.customerId);
        const data = normalizeCustomer(customer);
        return {
          text: `Customer ${data.id} — ${data.name}${data.email === undefined ? "" : ` <${data.email}>`}.`,
          data,
        };
      }),
  };
}
