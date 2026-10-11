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
