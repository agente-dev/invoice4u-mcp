# Security

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems. Private
reports are handled through **GitHub Security Advisories**:

1. Go to https://github.com/agente-dev/invoice4u-mcp/security/advisories/new
2. Provide a clear description, the affected version(s), steps to reproduce,
   and — if you have one — a suggested fix.
3. You should receive an acknowledgement within a few business days. We may ask
   for more detail before confirming a fix.

Thank you for reporting responsibly. We will coordinate a fix and a disclosure
before any public announcement.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ Supported |

Only the latest `0.1.x` patch release receives security fixes. Older minor
versions are not actively maintained; upgrade to the latest `0.1.x`.

## Credential handling (summary)

This is a credential-scoped server: it provisionally will run only with a valid
Invoice4U organization API token.

- **Environment-only:** the token comes from `INVOICE4U_API_TOKEN`. It is never
  a tool argument, never returned in tool output, and never written to logs.
- **Redaction:** a token appearing in any error message is replaced with
  `[REDACTED]` before the error can escape to an MCP client or a log.
- **No commits:** `.env`/`.env.*` are gitignored. Only `.env.example` is
  committed (with empty values). In CI the token is provided via the GitHub
  Actions secret `INVOICE4U_API_TOKEN` — never via the repository.
- **Transport:** the token is sent in the HTTPS request body only (never in a
  URL) and only to an allowlisted Invoice4U host derived from `INVOICE4U_ENV`
  (qa / production). There is no arbitrary base-URL override.

For the full threat model, see [docs/safety.md](./docs/safety.md).