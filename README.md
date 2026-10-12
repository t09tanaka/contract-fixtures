# contract-fixtures

[![CI](https://github.com/t09tanaka/contract-fixtures/actions/workflows/ci.yml/badge.svg)](https://github.com/t09tanaka/contract-fixtures/actions/workflows/ci.yml)
[![Example contracts](https://github.com/t09tanaka/contract-fixtures/actions/workflows/example.yml/badge.svg)](https://github.com/t09tanaka/contract-fixtures/actions/workflows/example.yml)

Shared request/response fixtures that keep an API and its clients in step, across languages.

The API's tests compare its **real responses** with fixture files. The client's tests **read the
same files** and feed them to the client's real response handling. When one side changes, the
other side's tests fail.

- A language-independent fixture format: [`spec/format.md`](./spec/format.md) (with JSON Schemas).
- A TypeScript package: [`packages/ts`](./packages/ts) (`@t09tanaka/contract-fixtures`).
- A Dart package: [`packages/dart`](./packages/dart) (`contract_fixtures`).
- A runnable example with a TypeScript API, a Dart client and a TypeScript client:
  [`example/`](./example).
- A guide for putting it into a project that already has tests:
  [`docs/adoption.md`](./docs/adoption.md).

Either language can be on either side.

## Install

```sh
npm install --save-dev @t09tanaka/contract-fixtures   # TypeScript: Node.js 20 or later
dart pub add --dev contract_fixtures                  # Dart 3.5 or later
```

> **Not published yet.** Version 0.1.0 is not on npm or pub.dev, so these two commands do not
> work for now. Until it is, install from the repository as described below.

### From the repository

A version that is not published can be installed from a clone (TypeScript) or straight from
git (Dart).

TypeScript: npm cannot install a package from a subdirectory of a git repository, so pack it
first and install the file.

```sh
git clone https://github.com/t09tanaka/contract-fixtures.git
cd contract-fixtures
npm ci
npm pack -w packages/ts --pack-destination ..   # builds, then writes ../t09tanaka-contract-fixtures-0.1.0.tgz

cd ../your-project
npm install --save-dev ../t09tanaka-contract-fixtures-0.1.0.tgz
npx contract-fixtures --version
```

After packing again without a new version number, run that `npm install --save-dev` line
again: the file has the same name, and `package-lock.json` still holds the checksum of the
earlier one. A plain `npm install` or `npm ci` then either installs the earlier content again
from npm's cache, or stops with `EINTEGRITY` where there is no such cache.

Dart: name the repository and the directory of the package in `pubspec.yaml`,

```yaml
dev_dependencies:
  contract_fixtures:
    git:
      url: https://github.com/t09tanaka/contract-fixtures.git
      path: packages/dart
```

then:

```sh
dart pub get
dart run contract_fixtures --version
```

## The problem

A client's tests usually run against responses somebody typed by hand: "the API returns this".
Those tests keep passing when the API returns something else. Mistakes that survive this way
include a field read as the wrong type, an error code spelled differently on the two sides, a
status code that means two things, and a calculation implemented twice with different rounding.

Other tools cover part of this:

- **Schema validation** (for example against an OpenAPI document) checks the shape of a message.
  It does not check the spelling of a value, usually tolerates unknown keys, and says nothing
  about what the client *does* with a response.
- **Snapshot tests** pin the output of one program. The snapshot of an API response lives with
  the API; the client's tests never see it.
- **Pact** has the consumer's tests write a contract against a mock provider and replays that
  contract against the provider. It comes with a matching DSL and provider states, and the
  contract is usually exchanged through a broker. That is more machinery than is needed when
  both sides live in one repository and the goal is "let the client read what the provider
  really returned".

`contract-fixtures` is deliberately small: plain JSON files, exact comparison, two helper
libraries without dependencies, and a check command.

## How it works

A contracts directory is committed next to the code of both sides:

```
contracts/
  provider/   one request and the provider's real response to it, per file
  consumer/   one request the consumer really builds, per file
  tables/     rows of input and expected output for a calculation both sides implement
  config.json optional: patterns of strings that must never be stored (see Secrets)
  .ledger/    written during test runs; ignored by version control
```

| | The provider's tests | The consumer's tests |
|---|---|---|
| `provider/*.json` | **verify**: send the request to the real API, compare the real response | **read**: feed the response to the real client code, assert what the client does |
| `consumer/*.json` | **read**: send the request to the real API, assert it is accepted | **verify**: compare the request the client really builds |
| `tables/*.json` | **read**: run the rows through the API's calculation | **read**: run the rows through the client's calculation |

Values that change on every run (ids, timestamps) are stored as they really were and listed
under `volatile`, preferably with the shape they keep (see
[Values that change](#values-that-change)). Secrets are never stored: the
test lists their paths under `secret`, and the file holds placeholders such as
`<token:customer-1>` in their place (see [Secrets](#secrets)). Everything else is compared
exactly, after parsing, so a formatter may rewrite the files.

Every verify and read is recorded in a ledger. `check` then fails if a fixture was not verified
by its producer (it is stale) or not read by the other side (it protects nothing). Each side
checks only its own ledger, so the API and the client can run in separate CI jobs.

## Getting started

### Provider side (TypeScript shown; the Dart API is the same)

```ts
import { contractFixtures, resolvePlaceholders } from "@t09tanaka/contract-fixtures";

const contract = contractFixtures({ side: "provider", dir: "../contracts" });

it("order.out-of-stock", async () => {
  const request = {
    method: "POST",
    path: "/orders",
    headers: { authorization: "<token:customer-1>" },
    body: { sku: "mug-200", quantity: 1 },
  };
  // Send the real secret to the API; record the placeholder. `send` goes over HTTP to the
  // application as it is deployed, for example with an HTTP test client.
  const response = await send(resolvePlaceholders(request, realSecret));

  contract.verifyResponse({
    name: "order.out-of-stock",
    description: "There are fewer items in stock than were ordered",
    request,
    response: { status: response.status, body: response.body },
  });
});
```

Run the test once with `CONTRACT_FIXTURES_UPDATE=1` to record
`contracts/provider/order.out-of-stock.json`, and commit the file.

### Consumer side (Dart shown; the TypeScript API is the same)

```dart
import 'package:contract_fixtures/contract_fixtures.dart';

final contract = ContractFixtures(side: ContractSide.consumer, dir: '../contracts');

/// Fixture name -> what the app must do when it receives that response.
const expectations = {
  'order.created': 'placed, total 1200',
  'order.out-of-stock': 'out of stock, 0 left',
  'order.token-invalid': 'sign in again',
};

void main() {
  test('every provider fixture has an expectation here', () {
    contract.assertCovers(FixtureKind.provider, expectations.keys);
  });

  for (final entry in expectations.entries) {
    test(entry.key, () {
      final fixture = contract.readResponse(entry.key);
      expect(outcome(fixture.response.status, fixture.response.body), entry.value);
    });
  }
}
```

### Keeping reading tests honest

The ledger shows that a test *loaded* a fixture, not that it asserted anything. The pattern
above closes most of that gap: keep a table from fixture name to expected behaviour, iterate
over it, and call `assertCovers` with its keys. A new fixture then fails the reading side until
somebody writes down what should happen for it, and a deleted fixture fails until its
expectation is removed. Whether the expectation is meaningful remains the job of code review.

With many fixtures, one table becomes unwieldy. Split it by the prefix of the names, and give
each test its part: `assertCovers(kind, names, { prefix: "order." })` looks only at the
fixtures that start with `order.`. One more test then lists the prefixes, so that the parts
cannot leave a fixture out:

```ts
contract.assertPrefixesCover("provider", ["order.", "payment.", "receipt."]);
```

It fails for a fixture that starts with none of them, and for a prefix that no fixture starts
with.

### HTTP in tests

The helpers take plain values (`{ method, path, headers, body }`, `{ status, headers, body }`),
so they fit any HTTP library. Where the values come from in practice:

- **A consumer that calls `fetch`** (TypeScript). Put a function in the place of `fetch` that
  answers with the fixture and keeps the request, so the client's real code builds the request
  and decodes the response:

  ```ts
  import { requestFromFetch, resolvePlaceholders, toFetchResponse } from "@t09tanaka/contract-fixtures";

  const sent: ExchangeRequest[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    sent.push(await requestFromFetch(input, init));
    const { response } = contract.readResponse("order.created");
    // Where the provider listed a secret, the fixture holds a placeholder; put a value in.
    return toFetchResponse(resolvePlaceholders(response, (kind, name) => `test ${kind} of ${name}`));
  };
  // ... run the client code with fakeFetch, assert what it made of the response, then:
  assert.equal(sent.length, 1);
  contract.verifyRequest({ name: "create-order.request", description: "...", request: sent[0]! });
  ```

  The line before the verify matters: this `fetch` answers every call, so a request the
  client should not have sent would otherwise go unnoticed.

- **A provider tested through an HTTP test client** (TypeScript). `exchangeFromTestResponse`
  reads the method, the path, the status and the body from the response object of the client,
  and the headers a test names:

  ```ts
  const res = await client.post("/orders").set("authorization", token).send(body);
  contract.verifyResponse({
    name: "order.created",
    description: "An order is accepted",
    ...exchangeFromTestResponse(res, { requestHeaders: ["authorization"], request: { body } }),
    secret: { "request.headers.authorization": "<token:customer-1>" },
  });
  ```

- **A Dart client on `package:http` or dio.** The Dart package has no HTTP dependency; its
  README shows the few lines that put a fixture behind a `MockClient` or an
  `HttpClientAdapter`, and how to answer several requests of one test in order.

These helpers record what a test hands them and nothing else, like the rest of the tool:
response headers by name only, and real credentials replaced through `secret`. See the
[TypeScript](./packages/ts/README.md#http-in-tests) and
[Dart](./packages/dart/README.md#http-in-tests) READMEs.

### Values that change

An id, a timestamp or an order number is new on every run. Such a value is stored as it really
was, and the test lists where it is under `volatile`:

```ts
volatile: [
  { path: "response.body.id", pattern: "^ord_[a-z0-9]+$" },
  { path: "response.body.**.created_at", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$" },
],
```

- An entry with a `pattern` says what the value looks like. The value may change, but it must
  be a string that matches the pattern as a whole, in the stored file and in every run. A
  response that starts to return `"81f3"` instead of `"ord_81f3"` fails the provider's test:
  `response.body.id: "ord_81f3" -> "81f3" (volatile: does not match ^ord_[a-z0-9]+$)`.
- An entry that is only a path (`"response.body.note"`) compares the JSON type and nothing
  else. Use it when there is nothing to say about the shape.
- A value that is a string in one place and `null` in another (the time something was closed, in
  a list of which some rows are closed and some are not) gets `nullable: true` next to its
  pattern:
  `{ path: "response.body.**.closed_at", pattern: "^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z$", nullable: true }`.
  Each such value is then a string of that shape or `null`, and which of the two it is may
  change between runs. Without `nullable`, a `null` where a pattern applies is not accepted,
  so the key says so only where it is meant. It needs a pattern, and an absent key is still
  not `null`.
- `*` stands for one key or index. `**` stands for any number of them, so
  `response.body.**.created_at` names every `created_at` in the body, at any depth.
- **Name the value, not its surroundings.** It is tempting to write
  `response.body.customer.**` to get rid of one timestamp inside `customer`; that also stops
  comparing the customer's status, its plan and every other value there. Name the key and give
  it a pattern instead. A path that ends in `**` (same keys and types below, values free) is
  for a subtree that really is arbitrary.
- When an id is a part of the path of a request, make the path volatile with a pattern:
  `{ path: "request.path", pattern: "^/orders/ord_[a-z0-9]+/receipt$" }`.

Patterns are a small, documented subset of ECMAScript regular expressions (character classes,
repetition, groups, choice, `^` and `$`; no look-around, no back references, no flags). Both
packages match them with the same algorithm of their own, so a pattern means the same in every
language and cannot make a test hang. The exact syntax is in
[`spec/format.md`](./spec/format.md#patterns).

### Response headers

Part of an agreement is often in the headers of the response: the file name of a download
(`content-disposition`), `content-type`, `cache-control`, `retry-after`, the cookies a sign-in
sets and a sign-out clears. A test passes the headers that matter, and only those:

```ts
contract.verifyResponse({
  name: "receipt.downloaded",
  description: "The receipt of an order is a download with a file name",
  request,
  response: {
    status: response.status,
    headers: {
      "content-type": response.headers["content-type"]!,
      "content-disposition": response.headers["content-disposition"]!,
    },
    body: response.body,
  },
});
```

Header names are stored in lower case, whatever case the test passes. A header that is sent
more than once is an array, and its order is compared:
`"set-cookie": ["<cookie:session-1>", "theme=dark; Path=/"]`. Request headers follow the same
rules. Paths reach into the array (`response.headers.set-cookie.0`), so one cookie can be
`secret` and another one `volatile`.

### Secrets

Fixtures are committed, so a real credential must never end up in one. That concerns requests
(an `authorization` header, a password) as much as responses (the access token a sign-in
returns, the secret a payment API hands to the client, a session cookie).

The verifying test says where the secrets are and which placeholder stands for each:

```ts
contract.verifyResponse({
  name: "payment.started",
  description: "Starting the payment of an order returns the key that confirms it",
  request,
  response: { status: response.status, body: response.body },
  volatile: [{ path: "response.body.id", pattern: "^pay_[a-z0-9]+$" }],
  secret: { "response.body.confirm_key": "<key:payment-1>" },
});
```

Before anything is compared, printed or written, the value at each secret path is replaced by
its placeholder. The real value does not reach the fixture file, the differences of a failing
test, an error message, or the ledger. The file holds `"confirm_key": "<key:payment-1>"`, and
that is compared exactly on every run, although the API returns a new key each time.

- The reading side receives the placeholder and replaces it with a value of its own
  (`resolvePlaceholders`) before it feeds the response to the client code.
- A path replaces a whole value; `*` stands for one key or index (`response.body.codes.*.code`),
  `**` is not allowed. A secret that is only a part of a string cannot be addressed: for
  `authorization: Bearer ...` or a `cookie` header, make the whole header value the secret
  (`"request.headers.authorization": "<token:customer-1>"`). A cookie the API sets is a secret
  as a whole too, attributes included; with several `set-cookie` headers, name each one by its
  index (`"response.headers.set-cookie.0": "<cookie:session-1>"`).
- A secret path that matches nothing, or a value there that is not a string, fails the test: a
  secret that disappears from a response is a change the other side needs to hear about.
- Update mode never drops a secret path. When the stored fixture lists a path that the test
  no longer passes, the fixture is not rewritten (the real value would end up in the file).
  Pass the path again, or remove it from the stored file by hand.
- For a request, a test may also pass the placeholder itself and send the real value to the
  code under test, as in the provider example above. Listing the path under `secret` as well
  makes the fixture say so.
- As a safety net, a fixture that contains a string of the shape of a JSON Web Token (`eyJ...`
  in three dot-separated parts, also inside `Bearer eyJ...`) is not written, in update mode
  either, and a stored one fails `check` as `invalid`. Other kinds of secrets (opaque tokens,
  API keys, cookies) have no shape the tool knows; a `secret` path keeps them out.
- A project can add shapes of its own. A file `config.json` in the contracts directory lists
  patterns of strings that must never be in a fixture, for credentials that start with a
  fixed prefix:

  ```json
  { "format": 1, "forbidden": ["sec_(live|test)_[A-Za-z0-9]+", "^hook_"] }
  ```

  The patterns are those of `volatile`, except that one matches when a part of the string
  does (`Bearer sec_live_...` is found). A string that matches is not written, in update mode
  either, and a stored one fails `check` as `invalid`; the message names the path and never
  the value. The answer is the same as for a token: list the path under `secret`, when the
  string is a value in headers or a body; anywhere else (a description, a pattern, the path of
  a request) the message says to change the text. Both sides
  and both packages read the same file; without it nothing changes.

### Requests and calculations

The other direction works the same way. The consumer calls `verifyRequest` with the request its
real code builds; the provider calls `readRequest` and sends it to the real API. A table is
read with `readTable` on both sides. See [`example/`](./example) for all three.

### In a project that already has tests

Which tests should verify, what to do with two clients of one API, with generated clients,
with shards in CI: see the [adoption guide](./docs/adoption.md). The short version of its
first rule: call `verifyResponse` only in tests that send a request to the application
assembled the way the deployed one is. A test with a mocked service, or one that calls a
handler directly, records an answer the API never gives.

## Changing a response on purpose

The intended workflow keeps both sides in **one change** (one pull request):

1. Change the API.
2. The provider's test fails and shows what changed:
   ```
   contract fixture provider/order.out-of-stock.json no longer matches what the provider side produces (stored -> observed):
     response.body.error: "out_of_stock" -> "sold_out"
   If the change is intended, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
   ```
3. Rerun the provider's tests with `CONTRACT_FIXTURES_UPDATE=1`. The fixture file changes.
4. The consumer's tests now fail, because the client does something else with the new response.
5. Fix the client (or reconsider the API change). Commit everything together.

A reviewer sees the changed fixture in the diff, next to the code on both sides.

When the response is another one altogether (an error where the order used to be), the test
shows that too: the status first, then the keys that went and the keys that came (a long
value is cut after 200 UTF-16 code units), and after them the volatile paths of the test that match
nothing any more. Update mode does not write such a fixture. Where it does write a 5xx over a
response that was none, it says so in one line on standard error, because that is more often
a test application that differs from the deployed one than a change of the API. [`example/`](./example/README.md#break-it) has the output, under (h).

## In CI

Each side resets its ledger, runs its tests, and runs the check:

```sh
# provider (TypeScript)
npx contract-fixtures reset --side provider --dir ../contracts
npm test
npx contract-fixtures check --side provider --dir ../contracts

# consumer (Dart)
dart run contract_fixtures reset --side consumer --dir ../contracts
dart test          # or: flutter test
dart run contract_fixtures check --side consumer --dir ../contracts
```

Run `check` after **all** tests of a side. It has no option to look at a part of the fixtures:
a run of a part of the tests (a filter, one shard) leaves the rest `unverified` or `unread`.
When the state of the ledger suggests a cause, the report ends with a hint:

```
$ dart run contract_fixtures check --side consumer --dir ../contracts
contract_fixtures check (consumer side): 8 problem(s) in 11 fixture(s)
  - provider/order.coupon-unknown.json: not read by the consumer side's tests (add a test that feeds it to the real code)
  ...
Hint: Only 3 of the 11 fixtures that follow the format were verified or read. If a part of the tests ran (a filter, one shard of several), run all of them, or join the ledgers of all shards, before this check.
Run `contract_fixtures reset` and the consumer side's tests before this check.
```

Other hints are given when the ledger is missing or has no entries (did the tests run, and on
this directory? is `--side` right, if the other side has a ledger?), when none of its entries
is for a fixture of this directory, and when it names files that are gone (was it reset?). A
hint is a guess; the problems and the exit code do not depend on it.

When the ledger has no entries at all, the fixtures are not the cause, and the report does not
list them one by one. From `example/provider`, after a `reset` and without the tests:

```
$ npx contract-fixtures check --side provider --dir ../contracts
contract-fixtures check (provider side): 11 problem(s) in 11 fixture(s)
  - none of the 11 fixture(s) that follow the format was verified or read by the provider side's tests (they are not listed one by one)
Hint: .ledger/provider.jsonl does not exist. Did the provider side's tests run, and do they use this contracts directory?
Run `contract-fixtures reset` and the provider side's tests before this check.
```
 The
[adoption guide](./docs/adoption.md#when-the-check-fails) has the usual cause of each.

The exit codes of the commands are listed under [Command line](#command-line).
`CONTRACT_FIXTURES_UPDATE=1` is refused in CI (see
[Environment variables](#environment-variables)), because it would turn every difference into
a pass. A CI job for one side should also be triggered by changes to the contracts directory.
The [adoption guide](./docs/adoption.md#ci) has workflow examples for separate jobs, `paths`,
shards and containers.

## Reading the fixtures side by side

`summary` prints one line per fixture: the request, the status, and the keys at the top of the
response body with their JSON types. It needs no `--side` and does not touch the ledger. Both
packages print the same text. For the example in this repository:

```
$ npx contract-fixtures summary --dir example/contracts
FIXTURE                                    REQUEST                            STATUS  RESPONSE BODY
provider/order.coupon-unknown              POST /orders                       422     {error: string}
provider/order.created                     POST /orders                       201     {coupon_redeemed_at: null, created_at: string, customer: string, id: string, status: string, total_minor: number}
provider/order.created-with-coupon         POST /orders                       201     {coupon_redeemed_at: string, created_at: string, customer: string, id: string, status: string, total_minor: number}
provider/order.invalid-quantity            POST /orders                       422     {error: string, field: string}
provider/order.out-of-stock                POST /orders                       409     {available: number, error: string}
provider/order.token-invalid               POST /orders                       401     {error: string}
provider/payment.started                   POST /payments                     201     {confirm_key: string, id: string, order_id: string, status: string}
provider/receipt.downloaded                GET /orders/ord_mv3vvd651/receipt  200     {lines: array, order_id: string, total_minor: number}
consumer/create-order.request              POST /orders                       -       -
consumer/create-order.with-coupon.request  POST /orders                       -       -
tables/order-total                         -                                  -       5 row(s)
```

A fixture is one exchange, so a difference between exchanges is easy to miss in review: an
error that is `{error: string}` on one route and `{code: string, message: string}` on another
shows here as two lines that do not line up.

The keys at the top are not always where the difference is. When every body is an envelope
(`{data: object, ok: boolean}` on each line), `--depth 2` opens the objects inside it, and
`--depth 3` those inside them (up to 9). An array that is reached shows its first element in
brackets, so the keys of a row of a list are there as soon as the list is (`[]` for an empty
array, `[mixed]` for elements of more than one type). In the table above, `--depth 2` turns
`lines: array` of the receipt into `lines: [{quantity: number, sku: string}]`. For an envelope:

```
--depth 1   {data: object, ok: boolean}
--depth 2   {data: {items: array, next: null, page: object}, ok: boolean}
--depth 3   {data: {items: [{id: string}], next: null, page: {cursor: object, "of all": number, size: number}}, ok: boolean}
```

## Command line

Both packages have the same three commands. The executable is `contract-fixtures` in the
TypeScript package (`npx contract-fixtures`) and `contract_fixtures` in the Dart package
(`dart run contract_fixtures`). Apart from that name, which is also the first word of their
messages, the two print the same text.

| Command | What it does |
|---|---|
| `reset --side <provider\|consumer> [--dir <contracts>]` | Forgets what earlier test runs of this side did. Run it before the tests. |
| `check --side <provider\|consumer> [--dir <contracts>]` | Fails unless this side's tests verified or read every fixture since the reset, and every fixture follows the format. Run it after all tests of this side. |
| `summary [--dir <contracts>] [--depth <n>]` | Prints one line per fixture. Takes no `--side` and does not touch the ledger. `--depth` (1 to 9, default 1) is the number of levels of objects in a response body that are opened. |

`--dir` is the **contracts directory**: the one that holds `provider/`, `consumer/` and
`tables/`. It is not the directory of a package, and it does not default to the current
directory: without `--dir` the commands use `CONTRACT_FIXTURES_DIR`, and without either they
exit with 2. `-h, --help` prints the help, `-v, --version` the version of the package.

| Exit code | `reset` | `check` | `summary` |
|---|---|---|---|
| 0 | The ledger of the side has no entries now | Every fixture follows the format and was verified or read by this side's tests | The lines were printed |
| 1 | The ledger could not be removed (it is not a file, or its directory cannot be written) | At least one problem: a fixture or `config.json` is `invalid`, a fixture is `unverified` or `unread`, the ledger has a line that is not an entry of this side, or there are no fixtures. Also when the command could not finish (a ledger that is not a file, a fixture that cannot be read) | The directory holds no fixtures, or the command could not finish |
| 2 | Wrong usage: an unknown command, option or argument, an option without its value, a missing or wrong `--side`, a `--depth`, no contracts directory, or a `--dir` that is not a directory | The same | The same, a `--side`, or a `--depth` that is not a whole number from 1 to 9 |

A `reset`, and a `check` without problems, print one line to standard output. From
`example/provider`:

```
$ npx contract-fixtures reset --side provider --dir ../contracts
contract-fixtures reset (provider side): OK (no entries in .ledger/provider.jsonl)
$ npx contract-fixtures check --side provider --dir ../contracts
contract-fixtures check (provider side): OK (11 fixture(s), all verified or read by this side's tests)
```

A `check` with problems prints its report to standard error, starting with
`contract-fixtures check (provider side): 1 problem(s) in 12 fixture(s)`. Wrong usage prints
one line that says what is wrong, an empty line and the help, to standard error.

### Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `CONTRACT_FIXTURES_DIR` | the helpers, the commands | The contracts directory, for a test that passes no `dir` and for a command without `--dir`. An empty value counts as not set. The helpers look it up when the directory is first used (a verify, a read, a list), not when the object is created, so a tool that only loads the test files does not need it. |
| `CONTRACT_FIXTURES_UPDATE` | the helpers | `1` turns update mode on for a test that passes no `update`: a verify writes a missing or differing fixture instead of failing. Every other value leaves it off. |
| `CI` | the helpers | With `true` or `1`, `CONTRACT_FIXTURES_UPDATE=1` is refused: the helpers throw a usage error before any test verifies. Update mode is for a developer's machine. |

## What it does not cover

Each of these is left out on purpose. The reason is given so that it is clear what to use
instead.

**Not detected**

- **Cases without a fixture.** Only the exchanges somebody recorded are protected. A fixture
  is an example, not a rule: it does not show that a field is always there.
- **A new enum member, a new field, a new status.** They appear in responses nobody recorded.
  The tool compares what was recorded and knows no schema that could say "this value is new".
- **Tests that read without asserting.** The ledger shows that a fixture was loaded. A table
  of expectations with `assertCovers` closes most of the gap (see "Keeping reading tests
  honest"); the rest is code review.
- **Secrets nobody listed.** Apart from the token shape described under "Secrets" and the
  patterns a project puts into `config.json`, a value is only kept out of a fixture when its
  path is under `secret`. A secret without a shape (an opaque token, a password, a cookie)
  cannot be recognised at all. Review new fixtures for it.
- **Old clients in the field.** The fixtures describe the code in the repository. A released
  app that users have not updated is not checked against a new API.
- **A test application that differs from the deployed one.** The tool records what the test
  hands it. A response from a mocked service or from an application assembled differently is
  recorded faithfully and is wrong. See the
  [adoption guide](./docs/adoption.md#which-tests-verify).

**Not expressed by the format**

- **Order and state.** A fixture is one request and one response, so that every file can be
  read and replayed alone. Disagreements that only show up across several calls, or in a
  particular server state, need a test of the flow.
- **Bodies that are not JSON.** A fixture is a JSON document that both sides parse and compare
  value by value; a PDF, a CSV file or an image has no place in it. For such a response,
  record the status and the headers (`content-type`, `content-disposition`) and leave the
  body out.
- **Signatures over raw bytes.** Fixtures are compared after parsing, and a formatter may
  rewrite them, so the exact bytes of a body are not kept. A signature over those bytes (a
  signed webhook) cannot be checked from a fixture.
- **Query strings as parameters.** The path of a request, query string included, is one
  string. The side that builds a request does so in a fixed way, so comparing the string (or
  giving it a pattern) is enough; the order or encoding of parameters is not interpreted.
- **A secret or a changing value inside a longer value.** `secret` and `volatile` address
  whole values, which keeps "what is stored" and "what is compared" unambiguous. For a token
  inside a header or a URL, make the whole value the secret; for a changing part of a string,
  give the string a pattern.

**Outside the tool**

- **Third-party services.** If the provider's tests stub a payment gateway, the fixture
  reflects the stub, not the gateway. The response of somebody else's service cannot be
  verified by your tests.
- **A side that is not in the repository.** Both checks need tests: a consumer nobody here
  owns (external callers, the sender of a webhook) cannot read or verify.
- **Matching rules, a broker, provider states, OpenAPI.** There is no matching DSL, no
  broker, no multi-step scenario and no OpenAPI integration, and no dependency on an HTTP
  client or a test framework. Comparison is exact, with `volatile` as the one exception.

## Repository layout

```
spec/            the format (format.md, JSON Schemas) and cases both packages must pass
packages/ts/     @t09tanaka/contract-fixtures
packages/dart/   contract_fixtures
example/         a TypeScript API with two clients (Dart, TypeScript), each with a contracts directory
docs/            the adoption guide
```

`spec/fixtures/` holds language-independent cases (comparison, validation, file output, the
messages of a failing verify, the configuration of a directory and the search for what it
forbids, check with its report and
hints, summary, coverage, and the command line with its help, messages and exit codes). Both packages run them in their own tests; that is how "the two packages
treat a fixture the same way" is kept true.

## Development

```sh
npm ci && npm run build
npm run lint && npm run typecheck && npm test   # TypeScript package
npm run example                                 # the example: provider side and web client

cd packages/dart && dart pub get
dart format --output=none --set-exit-if-changed . && dart analyze --fatal-infos && dart test
```

### Releasing

Both packages have the same version. For a release:

1. Set the version in `packages/ts/package.json`, `packages/ts/src/version.ts`,
   `packages/dart/pubspec.yaml` and `packages/dart/lib/src/version.dart`. A test in each
   package fails when the constant and the manifest differ.
2. In `CHANGELOG.md`, replace `(unreleased)` in the heading of the version with the date, and
   copy the file to `packages/ts/CHANGELOG.md` and `packages/dart/CHANGELOG.md`. A test in each
   package fails when a copy differs.
3. For the first release only: delete the note that starts with "Not published yet" under
   [Install](#install).
4. `npm pack --dry-run` in `packages/ts` and `dart pub publish --dry-run` in `packages/dart`
   must list the README, the licence and the changelog, and give no warning.

## Related tools

- [test-gates](https://github.com/t09tanaka/test-gates) (npm `@t09tanaka/test-gates`): gates for JavaScript and TypeScript. A list of the files that must not be wrong, each one pure, covered completely, guarded by a negative control and by a verdict on a mutation report.
- [test_gates](https://github.com/t09tanaka/test-gates-dart) (pub.dev): the same gates for Dart and Flutter.
- [dart_mutant](https://github.com/t09tanaka/dart_mutant): mutation testing for Dart, the tool that writes the mutation report those gates judge.

The gates and this tool guard different things. A gate guards one file: that the decisions
made inside it are tested, and that the tests would notice a change. `contract-fixtures`
guards what lies between two programs: that the requests and responses they agreed on have
not drifted apart on one side.

## License

MIT
