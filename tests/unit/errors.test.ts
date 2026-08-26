import { describe, expect, it } from "vitest";
import type { Invoice4uErrorKind } from "../../src/invoice4u/errors.js";
import {
  createInvoice4uError,
  fromApiErrors,
  INVOICE4U_ERROR_KINDS,
  Invoice4uErrorImpl,
  isInvoice4uError,
  isRetryable,
  kindForCode,
} from "../../src/invoice4u/errors.js";
import type { CommonError } from "../../src/invoice4u/types.js";

const error80: CommonError = { ID: 80, Error: "UnauthorizedUser" };

describe("error-code → kind mapping (verified API reference)", () => {
  const cases: ReadonlyArray<[number, Invoice4uErrorKind]> = [
    [80, "authentication_failed"],
    [66, "authentication_failed"],
    [134, "duplicate_api_identifier"],
    [321, "document_not_found"],
    [3, "document_not_found"],
    [37, "document_not_found"],
    [136, "document_not_found"],
    [7, "document_not_found"],
    [50, "allocation_exceeds_balance"],
    [49, "invoice_not_open"],
    [53, "invoice4u_validation_error"],
    [147, "network_error"],
    [999, "invoice4u_validation_error"],
    [0, "invoice4u_validation_error"],
  ];

  it.each(cases)("maps API error code %i → %s", (code, expected) => {
    expect(kindForCode(code)).toBe(expected);
  });
});

describe("isRetryable", () => {
  it("returns true for network_error only", () => {
    expect(isRetryable("network_error")).toBe(true);
    for (const kind of INVOICE4U_ERROR_KINDS) {
      if (kind === "network_error") continue;
      expect(isRetryable(kind)).toBe(false);
    }
  });

  it("accepts error instances", () => {
    expect(isRetryable(fromApiErrors([{ ID: 147, Error: "TimeoutDB" }]))).toBe(true);
    expect(isRetryable(fromApiErrors([error80]))).toBe(false);
  });
});

describe("kind set", () => {
  it("exposes exactly the nine required kinds", () => {
    expect([...INVOICE4U_ERROR_KINDS].sort()).toEqual(
      [
        "allocation_exceeds_balance",
        "authentication_failed",
        "document_not_found",
        "duplicate_api_identifier",
        "invoice4u_validation_error",
        "invoice_not_open",
        "network_error",
        "unexpected_response",
        "verification_failed",
      ].sort(),
    );
  });
});

describe("fromApiErrors", () => {
  it("builds the typed error from the Errors envelope", () => {
    const error = fromApiErrors([error80], { op: "GetBranches" });
    expect(error.kind).toBe("authentication_failed");
    expect(error.retryable).toBe(false);
    expect(error.op).toBe("GetBranches");
    expect(error.code).toBe(80);
    expect(error.apiErrors).toEqual([error80]);
    expect(error.message).toContain("GetBranches");
    expect(error.message).toContain("UnauthorizedUser");
    expect(error.message).toContain("80");
  });

  it("maps 134 to duplicate_api_identifier and carries the apiIdentifier", () => {
    const error = fromApiErrors([{ ID: 134, Error: "DocumentAlreadyCreated" }], {
      op: "CreateDocumentWithIdentifierValidation",
      apiIdentifier: "order-10045",
    });
    expect(error.kind).toBe("duplicate_api_identifier");
    expect(error.retryable).toBe(false);
    expect(error.apiIdentifier).toBe("order-10045");
    expect(error.code).toBe(134);
    expect(error.message).toContain("DocumentAlreadyCreated");
  });

  it("maps 147 to a retryable network_error", () => {
    const error = fromApiErrors([{ ID: 147, Error: "TimeoutDB" }], {
      op: "CreateDocumentWithIdentifierValidation",
    });
    expect(error.kind).toBe("network_error");
    expect(error.retryable).toBe(true);
  });

  it("uses the first error as the primary when multiple are present", () => {
    const error = fromApiErrors([{ ID: 49, Error: "DocumentStatusInValid" }, error80]);
    expect(error.kind).toBe("invoice_not_open");
    expect(error.apiErrors).toHaveLength(2);
  });
});

describe("createInvoice4uError", () => {
  it("derives retryable from the kind for every kind", () => {
    for (const kind of INVOICE4U_ERROR_KINDS) {
      const error = createInvoice4uError(kind, { message: `test ${kind}` });
      expect(error.kind).toBe(kind);
      expect(error.retryable).toBe(kind === "network_error");
    }
  });

  it("supports verification_failed and unexpected_response kinds", () => {
    expect(createInvoice4uError("verification_failed", { message: "id mismatch" }).kind).toBe(
      "verification_failed",
    );
    expect(
      createInvoice4uError("unexpected_response", { message: "bad shape", httpStatus: 418 })
        .httpStatus,
    ).toBe(418);
  });
});

describe("Invoice4uErrorImpl", () => {
  it("is an Error and passes the isInvoice4uError guard", () => {
    const error = fromApiErrors([error80], { op: "GetBranches" });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(Invoice4uErrorImpl);
    expect(isInvoice4uError(error)).toBe(true);
    expect(isInvoice4uError(new Error("plain"))).toBe(false);
    expect(isInvoice4uError("nope")).toBe(false);
  });

  it("redacts secrets from the message", () => {
    const error = fromApiErrors([{ ID: 80, Error: "UnauthorizedUser leaky-api-token-42" }], {
      op: "GetDocument",
    }) as Invoice4uErrorImpl;
    expect(error.message).toContain("leaky-api-token-42");
    error.redact("leaky-api-token-42");
    expect(error.message).not.toContain("leaky-api-token-42");
    expect(error.message).toContain("[REDACTED]");
  });
});
