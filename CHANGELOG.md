# Changelog

All notable changes to **@agente-dev/invoice4u-mcp** are documented here
following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Planned: full live-QA acceptance once credentials exist; npm publication.

## [0.1.0-rc.0] - 2026-08-26

### Added

- Full v0.1 tool surface (8 tools):
  - 7 read tools: `verify_connection`, `search_documents`, `get_document`,
    `search_customers`, `get_customer`, `list_branches`,
    `validate_linked_receipt` (read-only preflight).
  - 1 write tool: `create_linked_receipt`, gated behind
    `INVOICE4U_ALLOW_WRITES=true`, idempotent via a mandatory `apiIdentifier`.
- Typed Invoice4U client layer over the official HTTP API with a nine-kind
  typed error model, decimal-string money, and an environment host allowlist.
- 120 unit + contract tests passing (`npm test`), covering config, money,
  error mapping, all read tools, and the write tool's 10-step safety flow.
- Documentation: architecture, tool reference, reconciliation example,
  QA testing, safety, API coverage; README (EN/HE); SECURITY;
  CONTRIBUTING; `docs/`; `coverage-manifest.json`; `server.json`.
- CI workflow (lint / check / test / build / `npm pack` dry-run).

### Status notes

- **QA integration: BLOCKED** pending credentials. No public Invoice4U sandbox
  exists; live acceptance needs a QA org account + API token. The gated
  `tests/integration/qa.spec.ts` smoke test is skipped without a token.
- **npm publication: PENDING** the trusted-publishing link for
  `@agente-dev/invoice4u-mcp` on npmjs.com (see `release.yml` header).

[Unreleased]: https://github.com/agente-dev/invoice4u-mcp/compare/v0.1.0-rc.0...HEAD
[0.1.0-rc.0]: https://github.com/agente-dev/invoice4u-mcp/releases/tag/v0.1.0-rc.0