# Changelog

Both packages are versioned together.

## 0.1.0 (unreleased)

First version.

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
    `nullable: true` next to a pattern, for a value that is a string in one place and `null`
    in another;
    a key that contains a dot is one segment for `*` and `**`, and its value is held to the
    pattern of the entry, by validation as by the comparison, in both packages;
  - messages of a failing verify that show the cause first: when the response is another one
    altogether, the differences (status, keys that went, keys that came) come before the
    volatile paths that match nothing, in update mode too; a value that misses its pattern
    is shown; a secret path that the test stopped passing does not get the advice to rerun
    in update mode, which would refuse;
  - differences that stay readable: the status of a response comes first, and a value longer
    than 200 UTF-16 code units is cut; a note on standard error when update mode writes a 5xx over
    a response that was none;
  - an optional `config.json` in the contracts directory with `forbidden` patterns: a string
    in which one of them matches is not written, and a stored one is `invalid`, as for a
    token. For credentials with a shape of their own;
  - response headers next to request headers, with the same rules for both: lower-case
    names, and a string or an array of strings (a header that is sent more than once, such as
    `set-cookie`) as the value;
  - numbers are written and printed as ECMAScript writes them, in both packages, also beyond
    2^53;
  - `resolvePlaceholders` to put real values back on the reading side;
  - the contracts directory (`dir`, or `CONTRACT_FIXTURES_DIR`) is looked up at the first
    verify, read or list, not when the object is created, so that a tool that only loads the
    test files does not need it;
  - a `check` command that fails for unverified, unread and invalid fixtures, per side, and a
    `reset` command. Both end in one line of the form `<tool> <command> (<side> side): OK (...)`
    when nothing is wrong;
  - hints in the report of a failing `check`, from the state of the ledger: it is missing or
    empty, only the other side has one, a part of the tests ran, or it names files that are
    gone. The problems and the exit code do not depend on them. When the ledger has no
    entries, one line gives the number of fixtures in the place of the whole list;
  - `assertPrefixesCover`, for tests that split their table of expectations by the prefix of
    the fixture names: it fails for a fixture that no prefix covers, and for a prefix that no
    fixture starts with;
  - a `summary` command (`summarizeContracts`, `formatSummary`) that prints one line per
    fixture, with the status and the keys of the response body, to compare fixtures side by
    side; `--depth <n>` opens the objects inside a body, and shows an array as its first
    element;
  - `-h, --help` and `-v, --version`, and the exit codes `0` (no problems), `1` (problems
    found; for `summary`, no fixtures; or the command could not finish) and `2` (wrong
    usage). A ledger that is not a file is reported in the same words by both packages, by
    the commands and by the helpers. The executable is
    `contract-fixtures` in the TypeScript package and `contract_fixtures` in the Dart package,
    and that name is the only difference between what the two print.
- TypeScript only, on the standard `fetch` types and without a dependency: `toFetchResponse`
  (a `Response` from a fixture), `requestFromFetch` (the request behind the arguments of
  `fetch` or a `Request`), and `exchangeFromTestResponse` (the request and the response
  behind the response object of an HTTP test client; headers by name only).
- Shared cases in `spec/fixtures/` that both packages run, including the text of the command
  line (its help, its messages and its exit codes), of the report and the hints of the check,
  of the summary and of the coverage messages.
- An adoption guide (`docs/adoption.md`) and an example with an HTTP server, an app in Dart and
  a web client in TypeScript, each client with a contracts directory of its own.
