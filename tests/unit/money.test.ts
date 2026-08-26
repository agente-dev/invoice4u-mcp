import { describe, expect, it } from "vitest";
import type { DecimalMoney } from "../../src/invoice4u/money.js";
import {
  add,
  compare,
  equals,
  floatFromApi,
  fromMinor,
  isDecimalMoney,
  MoneyError,
  parseToMinor,
  subtract,
  toMinor,
} from "../../src/invoice4u/money.js";

function money(value: string): DecimalMoney {
  return value as DecimalMoney;
}

function expectMoneyError(action: () => unknown, code: MoneyError["code"]): void {
  try {
    action();
    expect.unreachable(`expected MoneyError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyError);
    expect(error).toMatchObject({ code });
  }
}

describe("parseToMinor", () => {
  it("parses decimal strings into integer minor units", () => {
    expect(parseToMinor("0")).toBe(0);
    expect(parseToMinor("0.00")).toBe(0);
    expect(parseToMinor("0.05")).toBe(5);
    expect(parseToMinor("117")).toBe(11700);
    expect(parseToMinor("117.0")).toBe(11700);
    expect(parseToMinor("117.00")).toBe(11700);
    expect(parseToMinor("1234.56")).toBe(123456);
    expect(parseToMinor("007.5")).toBe(750);
  });

  it("rejects values with more than 2 fraction digits (typed error)", () => {
    expectMoneyError(() => parseToMinor("1.234"), "too_many_decimals");
    expectMoneyError(() => parseToMinor("0.001"), "too_many_decimals");
    expectMoneyError(() => parseToMinor("1234.56789"), "too_many_decimals");
  });

  it("rejects negative values", () => {
    expectMoneyError(() => parseToMinor("-5"), "negative_not_allowed");
    expectMoneyError(() => parseToMinor("-0.01"), "negative_not_allowed");
    expectMoneyError(() => parseToMinor("-1234.56"), "negative_not_allowed");
  });

  it("rejects malformed input", () => {
    expectMoneyError(() => parseToMinor(""), "invalid_format");
    expectMoneyError(() => parseToMinor("abc"), "invalid_format");
    expectMoneyError(() => parseToMinor("12,50"), "invalid_format");
    expectMoneyError(() => parseToMinor("1.2.3"), "invalid_format");
    expectMoneyError(() => parseToMinor("1e3"), "invalid_format");
  });

  it("rejects values beyond the safe-integer minor range", () => {
    expectMoneyError(() => parseToMinor("90071992547409.92"), "non_integer_minor");
  });
});

describe("fromMinor / toMinor", () => {
  it("formats integer minor units to canonical two-decimal strings", () => {
    expect(fromMinor(0)).toBe("0.00");
    expect(fromMinor(5)).toBe("0.05");
    expect(fromMinor(50)).toBe("0.50");
    expect(fromMinor(11700)).toBe("117.00");
    expect(fromMinor(123456)).toBe("1234.56");
  });

  it("formats negative minor units (computed results only)", () => {
    expect(fromMinor(-40)).toBe("-0.40");
    expect(fromMinor(-500)).toBe("-5.00");
  });

  it("rejects non-integer or unsafe minor values", () => {
    expectMoneyError(() => fromMinor(1.5), "non_integer_minor");
    expectMoneyError(() => fromMinor(Number.NaN), "non_integer_minor");
    expectMoneyError(() => fromMinor(9_007_199_254_740_992), "non_integer_minor");
  });

  it("toMinor is the inverse of fromMinor", () => {
    expect(toMinor(fromMinor(123456))).toBe(123456);
    expect(toMinor(money("1234.56"))).toBe(123456);
    expect(fromMinor(toMinor(money("0.05")))).toBe("0.05");
  });
});

describe("parse/format round-trips", () => {
  it("normalizes any accepted input to a canonical two-decimal string", () => {
    for (const input of ["0", "0.0", "0.00", "117", "117.0", "117.00", "1234.56", "007.5"]) {
      expect(fromMinor(parseToMinor(input))).toBe(fromMinor(toMinor(money(input))));
    }
    expect(fromMinor(parseToMinor("1234.56"))).toBe("1234.56");
    expect(fromMinor(parseToMinor("117"))).toBe("117.00");
    expect(fromMinor(parseToMinor("0.05"))).toBe("0.05");
  });
});

describe("add / subtract", () => {
  it("adds with exact integer arithmetic (0.1 + 0.2 === 0.3)", () => {
    expect(parseToMinor(add(money("0.1"), money("0.2")))).toBe(30);
    expect(add(money("0.1"), money("0.2"))).toBe("0.30");
  });

  it("adds without float drift", () => {
    expect(add(money("1.10"), money("2.20"))).toBe("3.30");
    expect(add(money("117.00"), money("0.99"))).toBe("117.99");
    expect(add(money("0.01"), money("0.01"))).toBe("0.02");
  });

  it("subtracts exactly", () => {
    expect(subtract(money("3.30"), money("0.20"))).toBe("3.10");
    expect(subtract(money("117.00"), money("0.99"))).toBe("116.01");
  });

  it("subtract can produce negative results", () => {
    expect(subtract(money("0.10"), money("0.50"))).toBe("-0.40");
  });
});

describe("equals / compare", () => {
  it("compares in minor units with tolerance-free exactness", () => {
    expect(equals(money("0.10"), money("0.1"))).toBe(true);
    expect(equals(money("117.00"), money("117"))).toBe(true);
    expect(equals(money("117.00"), money("117.01"))).toBe(false);
  });

  it("orders amounts", () => {
    expect(compare(money("1.00"), money("2.00"))).toBe(-1);
    expect(compare(money("2.00"), money("1.00"))).toBe(1);
    expect(compare(money("1.50"), money("1.50"))).toBe(0);
  });
});

describe("floatFromApi", () => {
  it("converts an API float to a canonical decimal string via string round-trip", () => {
    expect(floatFromApi(117)).toBe("117.00");
    expect(floatFromApi(117.0)).toBe("117.00");
    expect(floatFromApi(117.5)).toBe("117.50");
    expect(floatFromApi(0)).toBe("0.00");
    expect(floatFromApi(0.1)).toBe("0.10");
    expect(floatFromApi(1234.56)).toBe("1234.56");
  });

  it("rounds excess precision to 2dp half-up without float arithmetic", () => {
    expect(floatFromApi(123.456)).toBe("123.46");
    expect(floatFromApi(1.005)).toBe("1.01");
    expect(floatFromApi(1e-7)).toBe("0.00");
    expect(floatFromApi(2.675)).toBe("2.68");
  });

  it("rejects non-finite inputs", () => {
    expectMoneyError(() => floatFromApi(Number.NaN), "not_finite");
    expectMoneyError(() => floatFromApi(Number.POSITIVE_INFINITY), "not_finite");
  });
});

describe("isDecimalMoney", () => {
  it("accepts only non-negative decimal strings with at most 2dp", () => {
    expect(isDecimalMoney("117")).toBe(true);
    expect(isDecimalMoney("117.5")).toBe(true);
    expect(isDecimalMoney("0.05")).toBe(true);
    expect(isDecimalMoney("-5")).toBe(false);
    expect(isDecimalMoney("1.234")).toBe(false);
    expect(isDecimalMoney("abc")).toBe(false);
  });
});
