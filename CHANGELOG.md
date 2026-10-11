# Changelog

Both packages are versioned together.

## 0.1.0

First release.

- Fixture format 1: provider fixtures, consumer fixtures, tables, volatile paths, secret
  placeholders, ledger (`spec/format.md`, JSON Schemas in `spec/schema/`).
- `@t09tanaka/contract-fixtures` (TypeScript, Node.js 20 or later) and `contract_fixtures`
  (Dart 3.5 or later), each with:
  - `verifyResponse` / `verifyRequest` with readable differences and an update mode
    (`CONTRACT_FIXTURES_UPDATE=1`);
  - `readResponse` / `readRequest` / `readTable`;
  - `list` and `assertCovers` to tie a table of expectations to the fixtures on disk;
  - `resolvePlaceholders` for secrets;
  - a `check` command that fails for unverified, unread and malformed fixtures, per side, and a
    `reset` command.
- Shared cases in `spec/fixtures/` that both packages run.
