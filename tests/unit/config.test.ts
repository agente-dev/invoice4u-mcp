import { describe, expect, it } from "vitest";
import type { Config, ConfigError, ConfigResult } from "../../src/config.js";
import { HOST_ALLOWLIST, loadConfig, resolveBaseUrl } from "../../src/config.js";

function expectConfig(result: ConfigResult): Config {
  if (!result.ok) {
    throw new Error(`expected valid config, got: ${JSON.stringify(result.errors)}`);
  }
  return result.config;
}

function expectErrors(result: ConfigResult): ConfigError[] {
  if (result.ok) {
    throw new Error("expected invalid config, got a valid one");
  }
  return result.errors;
}

describe("loadConfig", () => {
  it("accepts a valid QA configuration with defaults", () => {
    const config = expectConfig(
      loadConfig({ INVOICE4U_API_TOKEN: "tok-abc", INVOICE4U_ENV: "qa" }),
    );
    expect(config).toEqual({
      apiToken: "tok-abc",
      env: "qa",
      allowWrites: false,
      logLevel: "info",
      baseUrl: HOST_ALLOWLIST.qa,
    });
  });

  it("accepts production with explicit writes and log level", () => {
    const config = expectConfig(
      loadConfig({
        INVOICE4U_API_TOKEN: "tok-abc",
        INVOICE4U_ENV: "production",
        INVOICE4U_ALLOW_WRITES: "true",
        INVOICE4U_LOG_LEVEL: "debug",
      }),
    );
    expect(config.env).toBe("production");
    expect(config.allowWrites).toBe(true);
    expect(config.logLevel).toBe("debug");
    expect(config.baseUrl).toBe(HOST_ALLOWLIST.production);
  });

  it("reports a missing API token", () => {
    const errors = expectErrors(loadConfig({ INVOICE4U_ENV: "qa" }));
    expect(errors.map((e) => e.field)).toContain("INVOICE4U_API_TOKEN");
  });

  it("rejects an empty API token", () => {
    const errors = expectErrors(loadConfig({ INVOICE4U_API_TOKEN: "   ", INVOICE4U_ENV: "qa" }));
    expect(errors.map((e) => e.field)).toContain("INVOICE4U_API_TOKEN");
  });

  it("reports a missing environment", () => {
    const errors = expectErrors(loadConfig({ INVOICE4U_API_TOKEN: "tok-abc" }));
    expect(errors.map((e) => e.field)).toContain("INVOICE4U_ENV");
  });

  it("refuses an invalid environment value", () => {
    const errors = expectErrors(
      loadConfig({ INVOICE4U_API_TOKEN: "tok-abc", INVOICE4U_ENV: "prod" }),
    );
    const envError = errors.find((e) => e.field === "INVOICE4U_ENV");
    expect(envError).toBeDefined();
    expect(envError?.message).toContain("qa");
    expect(envError?.message).toContain("production");
    expect(envError?.message).toContain('"prod"');
  });

  it("refuses an invalid ALLOW_WRITES value", () => {
    const errors = expectErrors(
      loadConfig({
        INVOICE4U_API_TOKEN: "tok-abc",
        INVOICE4U_ENV: "qa",
        INVOICE4U_ALLOW_WRITES: "yes",
      }),
    );
    const writeError = errors.find((e) => e.field === "INVOICE4U_ALLOW_WRITES");
    expect(writeError).toBeDefined();
    expect(writeError?.message).toContain('"yes"');
  });

  it("defaults the log level to info", () => {
    const config = expectConfig(
      loadConfig({ INVOICE4U_API_TOKEN: "tok-abc", INVOICE4U_ENV: "qa" }),
    );
    expect(config.logLevel).toBe("info");
  });

  it("refuses an invalid log level", () => {
    const errors = expectErrors(
      loadConfig({
        INVOICE4U_API_TOKEN: "tok-abc",
        INVOICE4U_ENV: "qa",
        INVOICE4U_LOG_LEVEL: "verbose",
      }),
    );
    expect(errors.map((e) => e.field)).toContain("INVOICE4U_LOG_LEVEL");
  });

  it("collects every invalid field in one result", () => {
    const errors = expectErrors(loadConfig({}));
    expect(errors.map((e) => e.field).sort()).toEqual(["INVOICE4U_API_TOKEN", "INVOICE4U_ENV"]);
  });

  it("carries a field-level message on every error", () => {
    const errors = expectErrors(loadConfig({}));
    for (const error of errors) {
      expect(error.field.length).toBeGreaterThan(0);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).toContain(error.field);
    }
  });
});

describe("HOST_ALLOWLIST / base URL mapping", () => {
  it("maps qa to the QA host", () => {
    expect(resolveBaseUrl("qa")).toBe("https://apiqa.invoice4u.co.il/Services/ApiService.svc");
  });

  it("maps production to the prod host", () => {
    expect(resolveBaseUrl("production")).toBe(
      "https://api.invoice4u.co.il/Services/ApiService.svc",
    );
  });

  it("lists exactly the two allowlisted hosts", () => {
    expect(HOST_ALLOWLIST).toEqual({
      qa: "https://apiqa.invoice4u.co.il/Services/ApiService.svc",
      production: "https://api.invoice4u.co.il/Services/ApiService.svc",
    });
  });

  it("exposes the allowlisted base URL through config.baseUrl", () => {
    const config = expectConfig(
      loadConfig({ INVOICE4U_API_TOKEN: "tok-abc", INVOICE4U_ENV: "qa" }),
    );
    expect(config.baseUrl).toBe("https://apiqa.invoice4u.co.il/Services/ApiService.svc");
  });
});
