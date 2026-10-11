# Changelog

Both packages are versioned together.

## 0.1.0

First release.

- Fixture format 1: provider fixtures, consumer fixtures, tables, volatile paths, secret
  paths and placeholders, ledger (`spec/format.md`, JSON Schemas in `spec/schema/`).
- `@t09tanaka/contract-fixtures` (TypeScript, Node.js 20 or later) and `contract_fixtures`
  (Dart 3.5 or later), each with:
  - `verifyResponse` / `verifyRequest` with readable differences and an update mode
    (`CONTRACT_FIXTURES_UPDATE=1`);
  - `readResponse` / `readRequest` / `readTable`;
  - `list` and `assertCovers` to tie a table of expectations to the fixtures on disk;
  - `secret` paths on `verifyResponse` / `verifyRequest`: the real value at such a path is
    replaced by its placeholder before it is compared, printed or written, in requests and in
    responses;
  - a refusal to write, and an `invalid` from the check for, a fixture that contains a string
    of the shape of a JSON Web Token;
  - response headers next to request headers, with the same rules for both: lower-case
    names, and a string or an array of strings (a header that is sent more than once, such as
    `set-cookie`) as the value;
  - `resolvePlaceholders` to put real values back on the reading side;
  - a `check` command that fails for unverified, unread and malformed fixtures, per side, and a
    `reset` command.
- Shared cases in `spec/fixtures/` that both packages run.
