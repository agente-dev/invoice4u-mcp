/**
 * Environment-based configuration for the Invoice4U MCP server.
 *
 * Validation is total and exception-free: `loadConfig` never throws. It
 * returns a discriminated result that either carries a fully validated
 * `Config` or a list of field-level `ConfigError`s. The base URL is always
 * derived from the allowlist below — there is no environment override for it.
 */

export const HOST_ALLOWLIST = {
  qa: "https://apiqa.invoice4u.co.il/Services/ApiService.svc",
  production: "https://api.invoice4u.co.il/Services/ApiService.svc",
} as const;

/** The only environments the server may target. */
export type Invoice4uEnv = keyof typeof HOST_ALLOWLIST;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  /** Invoice4U API token. Never logged, never returned, never a tool argument. */
  apiToken: string;
  /** Explicitly selected environment. There is no default. */
  env: Invoice4uEnv;
  /** When false, write tools are not registered at all. */
  allowWrites: boolean;
  logLevel: LogLevel;
  /** Allowlisted base URL resolved from `env`. */
  baseUrl: string;
}

export interface ConfigError {
  /** The environment variable that failed validation. */
  field: string;
  /** Human-readable, field-level explanation. */
  message: string;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

type EnvSource = Record<string, string | undefined>;

/** Resolve the single allowed base URL for an environment. */
export function resolveBaseUrl(env: Invoice4uEnv): string {
  switch (env) {
    case "qa":
      return HOST_ALLOWLIST.qa;
    case "production":
      return HOST_ALLOWLIST.production;
  }
}

export function loadConfig(env: EnvSource = process.env): ConfigResult {
  const errors: ConfigError[] = [];

  const rawToken = env.INVOICE4U_API_TOKEN;
  if (rawToken === undefined || rawToken.trim() === "") {
    errors.push({
      field: "INVOICE4U_API_TOKEN",
      message: "INVOICE4U_API_TOKEN is required and must be a non-empty string.",
    });
  }

  const rawEnv = env.INVOICE4U_ENV;
  if (rawEnv === "qa" || rawEnv === "production") {
    // Valid environment — nothing to report.
  } else {
    errors.push({
      field: "INVOICE4U_ENV",
      message:
        rawEnv === undefined || rawEnv === ""
          ? 'INVOICE4U_ENV is required and must be exactly "qa" or "production". There is no default environment.'
          : `INVOICE4U_ENV must be exactly "qa" or "production"; got "${rawEnv}".`,
    });
  }

  let allowWrites = false;
  const rawAllowWrites = env.INVOICE4U_ALLOW_WRITES;
  if (rawAllowWrites !== undefined && rawAllowWrites !== "") {
    if (rawAllowWrites === "true") {
      allowWrites = true;
    } else if (rawAllowWrites !== "false") {
      errors.push({
        field: "INVOICE4U_ALLOW_WRITES",
        message: `INVOICE4U_ALLOW_WRITES must be exactly "true" or "false" (defaults to false when unset); got "${rawAllowWrites}".`,
      });
    }
  }

  let logLevel: LogLevel = "info";
  const rawLogLevel = env.INVOICE4U_LOG_LEVEL;
  if (rawLogLevel !== undefined && rawLogLevel !== "") {
    switch (rawLogLevel) {
      case "debug":
      case "info":
      case "warn":
      case "error":
        logLevel = rawLogLevel;
        break;
      default:
        errors.push({
          field: "INVOICE4U_LOG_LEVEL",
          message: `INVOICE4U_LOG_LEVEL must be one of debug, info, warn, error (defaults to info when unset); got "${rawLogLevel}".`,
        });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Both required values are guaranteed present: every missing/blank case is
  // reported above and we return before reaching this point, so the value
  // assertions below cannot fail.
  return {
    ok: true,
    config: {
      apiToken: env.INVOICE4U_API_TOKEN as string,
      env: env.INVOICE4U_ENV as Invoice4uEnv,
      allowWrites,
      logLevel,
      baseUrl: resolveBaseUrl(env.INVOICE4U_ENV as Invoice4uEnv),
    },
  };
}
