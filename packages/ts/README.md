# @t09tanaka/contract-fixtures

Shared request/response fixtures that keep an API and its clients in step. The provider's tests
verify the fixtures against real responses; the consumer's tests read them.

This is the TypeScript package. The idea, the workflow and the limits are described in the
[repository README](https://github.com/t09tanaka/contract-fixtures#readme); the file format is
in [`spec/format.md`](https://github.com/t09tanaka/contract-fixtures/blob/main/spec/format.md).
A Dart package with the same API reads and writes the same files.

- Node.js 20 or later. No runtime dependencies.
- ES modules and CommonJS, with type definitions.
- Independent of the test framework: failures are thrown as ordinary errors.

## Install

```sh
npm install --save-dev @t09tanaka/contract-fixtures
```

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
  volatile: ["response.body.id", "response.body.created_at"],
});

// A response with a secret in it: the file gets the placeholder, never the real value.
contract.verifyResponse({
  name: "session.created",
  description: "Signing in returns an access token",
  request: { method: "POST", path: "/sessions", body: { email, password: "<password:customer-1>" } },
  response: { status: res.status, body: res.body },
  secret: { "response.body.access_token": "<token:session-1>" },
});

// Pass every request the consumer recorded to the real handler.
const expectations = { "create-order.request": 201 };
contract.assertCovers("consumer", Object.keys(expectations));
const { request } = contract.readRequest("create-order.request");
const res = await callHandler(resolvePlaceholders(request, (kind, name) => secrets[`${kind}:${name}`]));

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
| `assertCovers(kind, names, { prefix? })` | both | Throws `ContractCoverageError` unless `names` are exactly the fixtures on disk. |

Calling a method from the wrong side throws `ContractUsageError`. A missing or malformed fixture
throws `ContractFixtureError`.

- `dir` defaults to the environment variable `CONTRACT_FIXTURES_DIR`.
- `update` defaults to `CONTRACT_FIXTURES_UPDATE=1`. In update mode a verify writes a missing or
  differing fixture and leaves a fixture that already agrees untouched. The environment variable
  is refused when `CI` is set.
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
  recognised.
- `response.headers` is recorded like `request.headers`: pass the headers that are part of the
  agreement. A value is a string, or an array of strings for a header that is sent more than
  once (`"set-cookie": [...]`, compared in order; `response.headers["set-cookie"]` of Node's
  `http` and `Headers.getSetCookie()` of `fetch` give such an array). Paths reach into the
  array: `response.headers.set-cookie.0`. A body that is not JSON is not recorded; pass the
  status and the headers only.
- Header names are lower-cased before comparing and writing. `body: null` and `body: undefined`
  both mean "no body". NaN and infinite numbers are refused.

Also exported:

| Function | What it does |
|---|---|
| `resolvePlaceholders(value, resolve)` | Copies a JSON value, replacing every `<kind:name>` string through `resolve(kind, name)`. |
| `parsePlaceholder(text)` | `{ kind, name }` or `null`. |
| `differences(stored, observed, volatile?)` | The comparison itself; returns `{ path, kind, text }[]`. |
| `formatDifferences(diffs)` | The lines of a mismatch message. |
| `validateFixture(kind, name, text)` / `validateFixtureValue(kind, name, value)` | Format validation; returns `{ code, path, message }[]`. |
| `checkContracts({ dir, side })` / `formatCheckResult(result)` | What the `check` command runs. |
| `resetLedger({ dir, side })` | What the `reset` command runs. |
| `canonicalJson(value)` / `compactJson(value)` | The text a fixture is written as; the text of a value inside a difference. |
| `runCli(argv, io)` | The command line as a function. |

## Command line

```sh
npx contract-fixtures reset --side provider --dir ../contracts   # before the tests
npx contract-fixtures check --side provider --dir ../contracts   # after the tests
```

`check` exits with `0` when every fixture follows the format and was verified or read by this
side's tests since the reset, `1` otherwise, and `2` for wrong usage. `--dir` defaults to
`CONTRACT_FIXTURES_DIR`.

With Jest or Vitest, the helpers append to the ledger from every worker; no reporter or plugin is
needed.

## License

MIT
