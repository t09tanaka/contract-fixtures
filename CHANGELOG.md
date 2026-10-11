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
  - volatile entries with a pattern (`{ path, pattern }`): the value may change but must match
    a pattern, written in a documented subset of ECMAScript regular expressions that both
    packages match with the same algorithm; `**` in the middle of a path
    (`response.body.**.created_at`); a pattern on `request.path` for ids in a path;
  - response headers next to request headers, with the same rules for both: lower-case
    names, and a string or an array of strings (a header that is sent more than once, such as
    `set-cookie`) as the value;
  - `resolvePlaceholders` to put real values back on the reading side;
  - a `check` command that fails for unverified, unread and malformed fixtures, per side, and a
    `reset` command;
  - hints in the report of a failing `check`, from the state of the ledger: it is missing or
    empty, only the other side has one, a part of the tests ran, or it names files that are
    gone. The problems and the exit code do not depend on them;
  - `assertPrefixesCover`, for tests that split their table of expectations by the prefix of
    the fixture names: it fails for a fixture that no prefix covers;
  - a `summary` command (`summarizeContracts`, `formatSummary`) that prints one line per
    fixture, with the status and the keys of the response body, to compare fixtures side by
    side.
- TypeScript only, on the standard `fetch` types and without a dependency: `toFetchResponse`
  (a `Response` from a fixture), `requestFromFetch` (the request behind the arguments of
  `fetch` or a `Request`), and `exchangeFromTestResponse` (the request and the response
  behind the response object of an HTTP test client; headers by name only).
- Shared cases in `spec/fixtures/` that both packages run, including the text of the hints,
  of the summary and of the coverage messages.
