/**
 * Decimal-string money module.
 *
 * ZERO float arithmetic: every value is carried as a canonical decimal string
 * (e.g. "1234.56") or, between operations, as integer minor units (agorot, 2dp
 * fixed). No value is ever multiplied, divided, added or compared as a float.
 *
 * Integer arithmetic in JS `number` is exact within ±2^53-1 minor units
 * (~90 trillion major units) — far beyond any realistic invoice total.
 *
 * Boundaries:
 * - `floatFromApi` is the ONLY sanctioned way to turn an API float total into
 *   money (it takes the float's shortest decimal representation and rounds to
 *   2dp with string arithmetic — no float math on values, only on scale).
 * - User-facing inputs are validated against the decimal-string shape
 *   (`^\d+(\.\d{1,2})?$`) and never pass through float.
 */

/** Reason codes for `MoneyError`. */
export type MoneyErrorCode =
  | "invalid_format"
  | "too_many_decimals"
  | "negative_not_allowed"
  | "non_integer_minor"
  | "not_finite";

/** Typed error for money operations. */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}

/**
 * Branded decimal-string money type. Canonical form is two fixed fraction
 * digits ("1234.56", "0.05"); computed results may carry a leading minus
 * ("-5.00"). Inputs (schemas.ts) are always non-negative.
 */
export type DecimalMoney = string & { readonly __decimalMoney: unique symbol };

/** Accepted input shape: digits with at most 2 fraction digits. */
const DECIMAL_MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** Throw a typed error when a decimal string has more than 2 fraction digits. */
function assertMaxTwoDecimals(value: string): void {
  if (/^\d+(\.\d{3,})$/.test(value)) {
    throw new MoneyError(
      "too_many_decimals",
      `"${value}" has more than 2 fraction digits; money is fixed at 2dp precision`,
    );
  }
}

/**
 * Parse a decimal string into integer minor units (agorot).
 * Rejects: negative values, empty strings, >2dp precision, non-numeric input.
 * Integer arithmetic exact for |result| < 2^53.
 */
export function parseToMinor(value: string): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new MoneyError("invalid_format", "money value must be a non-empty decimal string");
  }
  if (value.startsWith("-")) {
    throw new MoneyError(
      "negative_not_allowed",
      `"${value}" is negative; money inputs must be non-negative`,
    );
  }
  if (!DECIMAL_MONEY_RE.test(value)) {
    assertMaxTwoDecimals(value);
    throw new MoneyError(
      "invalid_format",
      `"${value}" is not a valid decimal money string (expected d+ or d+.d{1,2})`,
    );
  }
  const dot = value.indexOf(".");
  const intPart = dot === -1 ? value : value.slice(0, dot);
  const fracPart = dot === -1 ? "" : value.slice(dot + 1);
  const minor = Number(intPart) * 100 + Number(fracPart.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError(
      "non_integer_minor",
      `"${value}" exceeds the supported integer range for minor units`,
    );
  }
  return minor;
}

/**
 * Format integer minor units back to the canonical decimal string "1234.56".
 * Computed values may be negative; inputs must be safe integers.
 */
export function fromMinor(minor: number): DecimalMoney {
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError(
      "non_integer_minor",
      `minor value ${minor} must be a safe integer to format as money`,
    );
  }
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const intPart = Math.floor(abs / 100);
  const fracPart = abs % 100;
  return `${sign}${intPart}.${String(fracPart).padStart(2, "0")}` as DecimalMoney;
}

/** Parse a `DecimalMoney` string into integer minor units (agorot). */
export function toMinor(value: DecimalMoney): number {
  return parseToMinor(value);
}

/** Exact, tolerance-free equality in minor units. */
export function equals(a: DecimalMoney, b: DecimalMoney): boolean {
  return parseToMinor(a) === parseToMinor(b);
}

/** Compare two amounts in minor units; -1, 0 or 1. */
export function compare(a: DecimalMoney, b: DecimalMoney): -1 | 0 | 1 {
  const diff = parseToMinor(a) - parseToMinor(b);
  if (diff < 0) return -1;
  if (diff > 0) return 1;
  return 0;
}

/** Exact addition — e.g. add("0.1", "0.2") === "0.30". */
export function add(a: DecimalMoney, b: DecimalMoney): DecimalMoney {
  return fromMinor(parseToMinor(a) + parseToMinor(b));
}

/** Exact subtraction — results may be negative. */
export function subtract(a: DecimalMoney, b: DecimalMoney): DecimalMoney {
  return fromMinor(parseToMinor(a) - parseToMinor(b));
}

/**
 * Convert an API float (JSON `number`, e.g. Total: 117.0) to a canonical
 * decimal string via string round-trip: the float's shortest round-trip
 * decimal representation is expanded (handles exponent notation) and rounded
 * to 2dp with string arithmetic. No float arithmetic is performed on the
 * value — the only float involvement is obtaining its representation.
 */
export function floatFromApi(value: number): DecimalMoney {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError("not_finite", `expected a finite number, got ${String(value)}`);
  }
  const raw = String(value); // shortest round-trip decimal representation
  return roundHalfUpAtTwo(expandExponent(raw)) as DecimalMoney;
}

/** Accepts the same decimal-string shape as `DecimalMoney` (non-negative). */
export function isDecimalMoney(value: string): boolean {
  return typeof value === "string" && DECIMAL_MONEY_RE.test(value);
}

/** Expand exponent notation ("1.5e-7", "1e+21") to plain decimal digits. */
function expandExponent(raw: string): string {
  const eIndex = raw.search(/[eE]/);
  if (eIndex === -1) return raw;
  const mantissa = raw.slice(0, eIndex);
  const exponent = Number(raw.slice(eIndex + 1));
  const sign = mantissa.startsWith("-") ? "-" : "";
  const unsigned = sign === "" ? mantissa : mantissa.slice(1);
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  const allDigits = intPart + fracPart;
  const pointPos = intPart.length + exponent;
  if (pointPos <= 0) {
    return `${sign}0.${"0".repeat(-pointPos)}${allDigits}`;
  }
  if (pointPos >= allDigits.length) {
    return `${sign}${allDigits}${"0".repeat(pointPos - allDigits.length)}`;
  }
  return `${sign}${allDigits.slice(0, pointPos)}.${allDigits.slice(pointPos)}`;
}

/** Round a plain decimal string to 2 fraction digits, half up, string-only. */
function roundHalfUpAtTwo(value: string): string {
  const sign = value.startsWith("-") ? "-" : "";
  const unsigned = sign === "" ? value : value.slice(1);
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  const kept = fracPart.slice(0, 2);
  const dropped = fracPart.slice(2);
  const roundUp = dropped.length > 0 && Number(dropped[0] ?? "0") >= 5;
  let int = intPart;
  let frac = kept.padEnd(2, "0");
  if (roundUp) {
    let next = Number(frac) + 1;
    if (next >= 100) {
      next -= 100;
      int = (BigInt(intPart) + 1n).toString();
    }
    frac = String(next).padStart(2, "0");
  }
  return `${sign}${int}.${frac}`;
}
