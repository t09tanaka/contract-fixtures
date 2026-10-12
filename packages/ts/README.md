# @t09tanaka/contract-fixtures

[![CI](https://github.com/t09tanaka/contract-fixtures/actions/workflows/ci.yml/badge.svg)](https://github.com/t09tanaka/contract-fixtures/actions/workflows/ci.yml)

Shared request/response fixtures that keep an API and its clients in step. The provider's tests
verify the fixtures against real responses; the consumer's tests read them.

This is the TypeScript package. The idea, the workflow and the limits are described in the
[repository README](https://github.com/t09tanaka/contract-fixtures#readme); the file format is
in [`spec/format.md`](https://github.com/t09tanaka/contract-fixtures/blob/main/spec/format.md).
A Dart package with the same core API reads and writes the same files. For a project that
already has tests, see the
[adoption guide](https://github.com/t09tanaka/contract-fixtures/blob/main/docs/adoption.md).

- Node.js 20 or later. No runtime dependencies.
- The type definitions use the global `fetch` types (`Request`, `Response`, `RequestInit`), so
  a TypeScript project needs `@types/node` (20 or later) or the `DOM` library.
- ES modules and CommonJS, with type definitions.
- Independent of the test framework: failures are thrown as ordinary errors.

## Install

```sh
npm install --save-dev @t09tanaka/contract-fixtures
```

To install a version that is not on npm, from the repository, see
[Install](https://github.com/t09tanaka/contract-fixtures#install)
in the repository README.

## Use

```ts
import { contractFixtures, resolvePlaceholders } from "@t09tanaka/contract-fixtures";

// One object per test file. `dir` is resolved against the working directory.
const contract = contractFixtures({ side: "provider", dir: "../contracts" });
```

### Provider side

```ts
// Verify a real response against contracts/provider/<name>.json.
contract.verifyResponse({
  name: "order.created",
  description: "An order is accepted",
  request: { method: "POST", path: "/orders", headers: { authorization: "<token:customer-1>" }, body },
  response: { status: res.status, body: res.body },
  // Values that change, each with the shape it keeps.
  volatile: [
    { path: "response.body.id", pattern: "^ord_[a-z0-9]+$" },
    { path: "response.body.**.created_at", pattern: "^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z$" },
  ],
});

// A response with a secret in it: the file gets the placeholder, never the real value.
contract.verifyResponse({
  name: "session.created",
  description: "Signing in returns an access token",
  request: { method: "POST", path: "/sessions", body: { email, password: "<password:customer-1>" } },
  response: { status: res.status, body: res.body },
  secret: { "response.body.access_token": "<token:session-1>" },
});

// Send every request the consumer recorded to the real API.
const expectations = { "create-order.request": 201 };
contract.assertCovers("consumer", Object.keys(expectations));
const { request } = contract.readRequest("create-order.request");
const res = await send(resolvePlaceholders(request, (kind, name) => secrets[`${kind}:${name}`]));

// Run a shared table through this side's calculation.
for (const row of contract.readTable<Row>("order-total").rows) { /* assert */ }
```

### Consumer side

```ts
const contract = contractFixtures({ side: "consumer", dir: "../contracts" });

// Feed real responses to the client code and assert what the client does.
const expectations = { "order.created": "placed", "order.out-of-stock": "out of stock" };
contract.assertCovers("provider", Object.keys(expectations));
const { response } = contract.readResponse("order.created");
// Where the provider listed a secret, the fixture holds a placeholder; put a value in first.
const body = resolvePlaceholders(response.body, (kind, name) => `test ${kind} of ${name}`);

// Verify the request the client really builds against contracts/consumer/<name>.json.
contract.verifyRequest({
  name: "create-order.request",
  description: "The request the client sends to place an order",
  request: { method: "POST", path: "/orders", headers, body },
});
```

## API

`contractFixtures({ side, dir?, update? })` returns an object with:

| Member | Side | What it does |
|---|---|---|
| `verifyResponse(observed)` | provider | Compares with `provider/<name>.json`; throws `ContractMismatchError` listing the differences. Writes the file in update mode. |
| `verifyRequest(observed)` | consumer | The same for `consumer/<name>.json`. |
| `readResponse(name)` | consumer | Reads and validates `provider/<name>.json`. |
| `readRequest(name)` | provider | Reads and validates `consumer/<name>.json`. |
| `readTable<Row>(name)` | both | Reads and validates `tables/<name>.json`. |
| `list(kind, { prefix? })` | both | Sorted fixture names of `"provider"`, `"consumer"` or `"tables"`. |
| `assertCovers(kind, names, { prefix? })` | both | Throws `ContractCoverageError` unless `names` are exactly the fixtures on disk (those that start with `prefix`). |
| `assertPrefixesCover(kind, prefixes)` | both | Throws `ContractCoverageError` unless every fixture starts with one of `prefixes` and every prefix has a fixture. Use it once next to several `assertCovers` with a prefix. |

Calling a method from the wrong side throws `ContractUsageError`. A missing or invalid fixture
throws `ContractFixtureError`.

- `dir` defaults to the environment variable `CONTRACT_FIXTURES_DIR`. It is looked up when
  the directory is first used (a verify, a read, `list`, `dir` itself), not by
  `contractFixtures(...)`: a tool that only loads the test files, to collect other tests or
  to run mutation tests on a part of them, does not need the variable. A missing directory
  throws `ContractUsageError` at that first use.
- `update` defaults to `CONTRACT_FIXTURES_UPDATE=1`. In update mode a verify writes a missing or
  differing fixture and leaves a fixture that already agrees untouched. The environment variable
  is refused when `CI` is `true` or `1`.
- `observed.volatile` lists the values that change between runs. An entry is a path
  (`"response.body.note"`: only the JSON type is compared) or `{ path, pattern }` (a string
  that must match the pattern as a whole; type `VolatileEntry`). In a path, `*` is one key or
  index and `**` any number of them: `response.body.**.created_at`. A path that ends in `**`
  compares keys and types of everything below and cannot have a pattern. `request.path` can
  be volatile too: `{ path: "request.path", pattern: "^/orders/ord_[a-z0-9]+/receipt$" }`.
  Patterns are a subset of ECMAScript regular expressions that the package matches itself
  (not with `RegExp`); see `spec/format.md`. A value that does not match is a difference, and
  is never written in update mode. For a value that is a string in one place and `null` in
  another, add `nullable: true` to the entry: `{ path: "response.body.**.closed_at", pattern:
  "...", nullable: true }` accepts a string that matches or `null`, and which of the two it is
  may change between runs. `nullable` needs a `pattern`, and `true` is its only value.
- When a volatile path of the test matches nothing in what the test passes, the verify still
  compares: the `ContractMismatchError` lists the differences first (the status and the keys
  of a response that is another one altogether) and the paths after them, also as
  `error.unmatched`. Such a fixture is never written.
- `observed.secret` maps paths to placeholders, for example
  `{ "response.body.access_token": "<token:session-1>" }`. The string at each path is replaced
  by its placeholder before anything is compared, printed or written, so the real value is not
  in the file, in a difference, in an error message or in the ledger. A path replaces a whole
  value (`*` for one key or index, no `**`); for a secret inside a string, such as
  `Bearer ...` or a cookie, make the whole header value the secret. A path that matches
  nothing, or a value that is not a string, throws `ContractFixtureError`. So does update mode
  when the stored fixture lists a secret path that the test does not pass: remove the path
  from the stored file by hand if it is no longer a secret.
- A fixture that contains a string of the shape of a JSON Web Token is not written (in update
  mode either) and fails `check`; list its path in `secret`. Other kinds of secrets are not
  recognised, unless the contracts directory has a `config.json` that describes them:
  `{ "format": 1, "forbidden": ["sec_live_[A-Za-z0-9]+"] }` refuses every string in which one
  of the patterns matches, the same way. `readConfig(dir)` and `validateConfig(text)` return
  what the file says and how it does not follow the format.
- `response.headers` is recorded like `request.headers`: pass the headers that are part of the
  agreement. A value is a string, or an array of strings for a header that is sent more than
  once (`"set-cookie": [...]`, compared in order; `response.headers["set-cookie"]` of Node's
  `http` and `Headers.getSetCookie()` of `fetch` give such an array). Paths reach into the
  array: `response.headers.set-cookie.0`. A header whose value is `undefined` is left out, like
  one that was not passed. A body that is not JSON is not recorded; pass the status and the
  headers only.
- Header names are lower-cased before comparing and writing. `body: null` and `body: undefined`
  both mean "no body". NaN and infinite numbers are refused.

## HTTP in tests

Three functions connect the helpers to the HTTP objects tests already have. They use the
standard `fetch` types of Node.js and read a test client by the shape of its objects; the
package still has no dependencies.

### A consumer that calls `fetch`

```ts
import { requestFromFetch, resolvePlaceholders, toFetchResponse, type ExchangeRequest } from "@t09tanaka/contract-fixtures";

const sent: ExchangeRequest[] = [];
/** Answers with a fixture and keeps what was sent. Give it to the client in the place of fetch. */
const fetchFixture = (name: string): typeof fetch => async (input, init) => {
  sent.push(await requestFromFetch(input, init));
  const { response } = contract.readResponse(name);
  return toFetchResponse(resolvePlaceholders(response, (kind, name) => `test ${kind} of ${name}`));
};
```

- `toFetchResponse(response)` returns a `Response` with the status, the headers and the JSON
  body of the fixture, and nothing else. It does not add a `content-type`: if the client looks
  at that header, the provider's test should record it. An array of values becomes one header
  per value (`set-cookie`). What a `Response` cannot be built from throws
  `ContractUsageError`: a status outside 200 to 599, a body with 204, 205 or 304, a header
  name or value that `fetch` does not accept.
- `await requestFromFetch(input, init?, { headers? })` returns `{ method, path, headers, body }`
  for the arguments of `fetch` or for a `Request`. `path` is the path and the query string
  (the origin is dropped). `headers` are those of the request, including the `content-type`
  that `fetch` itself gives a body (`text/plain;charset=UTF-8` for a string without one), or
  only the names listed in `headers`. `method` is what `fetch` would send (it leaves `patch`
  in lower case, which then fails the verify). `body` is parsed as JSON; a body that is not
  JSON throws, without showing it. Pass the result to `verifyRequest`, with `secret` for the
  credentials in it.

### A provider tested through an HTTP test client

```ts
import { exchangeFromTestResponse } from "@t09tanaka/contract-fixtures";

const res = await client.post("/orders").set("authorization", token).send(body);

contract.verifyResponse({
  name: "order.created",
  description: "An order is accepted",
  ...exchangeFromTestResponse(res, {
    requestHeaders: ["authorization"],
    responseHeaders: ["content-type"],
    request: { body },
  }),
  secret: { "request.headers.authorization": "<token:customer-1>" },
});
```

`exchangeFromTestResponse(res, options?)` returns `{ request, response }`. It reads `res` by
shape: `status` or `statusCode`; `body` (no body when `text` is `""`, because such clients give
`{}` for an empty response); `headers`; and under `request` or `req` the `method`, the `url` or
`path`, and `headers` or `header`. That is the shape of the response of supertest, and of
objects like it. When `text` is not JSON and `body` is `{}` (what such clients give for HTML or
plain text), it throws and asks for `response: { body }`.

| Option | |
|---|---|
| `requestHeaders`, `responseHeaders` | Names of the headers to record. Default: none. A response carries `date`, `connection` and `content-length`, which are not part of an agreement, so headers are recorded by name only. A named header that is absent is left out. |
| `request`, `response` | Parts to add or to replace: `request: { body }` for the body that was sent (it is not read from the client), `response: { body: res.text }` or `{ body: null }` when the parsed body is not what should be recorded, `request: { method, path }` for an object without a request. What a test passes replaces what was read: `request: { headers }` replaces the headers picked by `requestHeaders`, it is not merged with them. |

Without a method, a path or a status it throws `ContractUsageError` and says which is lacking.

Also exported:

| Function | What it does |
|---|---|
| `resolvePlaceholders(value, resolve)` | Copies a JSON value, replacing every `<kind:name>` string through `resolve(kind, name)`. |
| `parsePlaceholder(text)` | `{ kind, name }` or `null`. |
| `differences(stored, observed, volatile?)` | The comparison itself; returns `{ path, kind, text }[]`. |
| `formatDifferences(diffs)` | The lines of a mismatch message. |
| `validateFixture(kind, name, text)` / `validateFixtureValue(kind, name, value)` | Format validation; returns `{ code, path, message }[]`. |
| `checkContracts({ dir, side })` / `formatCheckResult(result)` | What the `check` command runs. The result has `problems` and `hints`. |
| `summarizeContracts({ dir })` / `formatSummary(rows)` | What the `summary` command runs. |
| `resetLedger({ dir, side })` | What the `reset` command runs. |
| `canonicalJson(value)` / `compactJson(value)` | The text a fixture is written as; the text of a value inside a difference. |
| `runCli(argv, io)` | The command line as a function. |

## Command line

```sh
npx contract-fixtures reset --side provider --dir ../contracts   # before the tests
npx contract-fixtures check --side provider --dir ../contracts   # after the tests
npx contract-fixtures summary --dir ../contracts                 # any time; --depth 2 looks one level deeper
npx contract-fixtures --version                                  # also -v; --help or -h for the help
```

`--dir` is the **contracts directory**: the one that holds `provider/`, `consumer/` and
`tables/`, not the directory of a package. It defaults to the environment variable
`CONTRACT_FIXTURES_DIR`, not to the current directory.

| Exit code | `reset` | `check` | `summary` |
|---|---|---|---|
| 0 | The ledger of the side has no entries now | Every fixture follows the format and was verified or read by this side's tests | The lines were printed |
| 1 | The ledger could not be removed (it is not a file, or its directory cannot be written) | At least one problem: a fixture or `config.json` is `invalid`, a fixture is `unverified` or `unread`, the ledger has a line that is not an entry of this side, or there are no fixtures. Also when the command could not finish (a ledger that is not a file, a fixture that cannot be read) | The directory holds no fixtures, or the command could not finish |
| 2 | Wrong usage: an unknown command, option or argument, an option without its value, a missing or wrong `--side`, a `--depth`, no contracts directory, or a `--dir` that is not a directory | The same | The same, a `--side`, or a `--depth` that is not a whole number from 1 to 9 |

A `reset`, and a `check` without problems, print one line to standard output:

```
contract-fixtures reset (provider side): OK (no entries in .ledger/provider.jsonl)
contract-fixtures check (provider side): OK (4 fixture(s), all verified or read by this side's tests)
```

Run `check` after all tests of the side: it always looks at every fixture. With problems it
prints a report to standard error. When the ledger suggests why fixtures were not touched (it
is missing or empty, only the other side has one, a part of the tests ran, it names files that
are gone), the report ends with a line that starts with `Hint:`. When the ledger has no
entries at all, one line gives the number of fixtures in the place of the whole list.

`summary` prints one line per fixture, to compare them side by side: the request, the status,
and the keys of the response body with their types. It takes no `--side` and does not touch
the ledger. `--depth 2` opens the objects inside a body as well (`{data: object}` becomes
`{data: {id: string, ...}}`), up to `--depth 9`; arrays are not opened.

```
FIXTURE                        REQUEST       STATUS  RESPONSE BODY
provider/order.created         POST /orders  201     {created_at: string, id: string, lines: array, status: string, total_minor: number}
provider/order.out-of-stock    POST /orders  409     {error: string}
consumer/create-order.request  POST /orders  -       -
tables/order-total             -             -       2 row(s)
```

With Jest or Vitest, the helpers append to the ledger from every worker; no reporter or plugin is
needed.

The environment variables (`CONTRACT_FIXTURES_DIR`, `CONTRACT_FIXTURES_UPDATE`, `CI`) are in
one table in the
[repository README](https://github.com/t09tanaka/contract-fixtures#environment-variables).

## Related tools

The gates for the code that must not be wrong (`test-gates`, `test_gates`) and the mutation
testing behind them (`dart_mutant`) are listed in the
[repository README](https://github.com/t09tanaka/contract-fixtures#related-tools),
with what they guard and what this package guards.

## License

MIT
