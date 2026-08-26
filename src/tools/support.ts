/**
 * Shared plumbing for the read-tool surface (Train C).
 *
 * Every read tool:
 * - is registered with the same read-only annotation set;
 * - returns `{ content: [text], structuredContent }` on success;
 * - converts expected failures (client `Invoice4uError` and tool-level
 *   preflight failures) into an `isError: true` result carrying a structured
 *   `{ error: { kind, message, retryable, apiErrors?, details? } }` object.
 *
 * Nothing here ever performs a write; unexpected errors are rethrown so the
 * MCP SDK converts them into its generic internal-error result (malformed
 * protocol input is rejected by the SDK's own input validation with an
 * `McpError` before any handler runs).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { Invoice4uClient } from "../invoice4u/client.js";
import {
  type Invoice4uError,
  type Invoice4uErrorKind,
  isInvoice4uError,
} from "../invoice4u/errors.js";
import type { CommonError } from "../invoice4u/types.js";

/** Everything a read tool needs: the typed client + validated config. */
export interface ToolDeps {
  client: Invoice4uClient;
  config: Config;
}

/** The single annotation set for the seven read tools. */
export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * A tool-level (preflight) failure with one of the client's nine error kinds.
 * Carries optional structured `details` surfaced alongside the standard
 * error shape (e.g. which invoices failed and why).
 */
export class ToolError extends Error {
  readonly kind: Invoice4uErrorKind;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: Invoice4uErrorKind,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** The structure of the `error` object in a structured error result. */
export interface StructuredErrorShape {
  kind: Invoice4uErrorKind;
  message: string;
  retryable: boolean;
  apiErrors?: CommonError[];
  details?: Record<string, unknown>;
}

/** Normalize any expected failure into the structured error shape. */
export function toStructuredErrorShape(error: Invoice4uError | ToolError): StructuredErrorShape {
  const shape: StructuredErrorShape = {
    kind: error.kind,
    message: error.message,
    retryable: error.retryable,
  };
  if (error instanceof ToolError) {
    if (error.details !== undefined) shape.details = error.details;
  } else {
    if (error.apiErrors !== undefined && error.apiErrors.length > 0) {
      shape.apiErrors = error.apiErrors;
    }
  }
  return shape;
}

/** Build the isError CallToolResult for an expected failure. */
export function structuredErrorResult(error: Invoice4uError | ToolError): CallToolResult {
  const shape = toStructuredErrorShape(error);
  return {
    content: [{ type: "text", text: `${error.kind}: ${error.message}` }],
    structuredContent: { error: shape },
    isError: true,
  };
}

/** Success helper: short human text alongside the full structured payload. */
export function readResult<T extends object>(
  text: string,
  structuredContent: T,
): CallToolResult & { structuredContent: T } {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  } as CallToolResult & { structuredContent: T };
}

/**
 * Run a read op, converting expected failures into structured error results
 * and passing everything else (bugs, protocol misuse) up to the SDK.
 */
export async function guardedRead<T extends object>(
  run: () => Promise<{ text: string; data: T }>,
): Promise<CallToolResult> {
  try {
    const { text, data } = await run();
    return readResult(text, data);
  } catch (error) {
    if (isInvoice4uError(error) || error instanceof ToolError) {
      return structuredErrorResult(error);
    }
    throw error;
  }
}
