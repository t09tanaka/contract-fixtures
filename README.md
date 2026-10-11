# contract-fixtures

Shared request/response fixtures that keep an API and its clients in step, across languages.

The API's tests compare its **real responses** with fixture files. The client's tests **read the
same files** and feed them to the client's real response handling. When one side changes, the
other side's tests fail.

- A language-independent fixture format: [`spec/format.md`](./spec/format.md) (with JSON Schemas).
- A TypeScript package: [`packages/ts`](./packages/ts) (`@t09tanaka/contract-fixtures`).
- A Dart package: [`packages/dart`](./packages/dart) (`contract_fixtures`).
- A runnable example with a TypeScript API and a Dart client: [`example/`](./example).

Either language can be on either side.

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
  .ledger/    written during test runs; ignored by version control
```

| | The provider's tests | The consumer's tests |
|---|---|---|
| `provider/*.json` | **verify**: call the real handler, compare the real response | **read**: feed the response to the real client code, assert what the client does |
| `consumer/*.json` | **read**: pass the request to the real handler, assert it is accepted | **verify**: compare the request the client really builds |
| `tables/*.json` | **read**: run the rows through the server's calculation | **read**: run the rows through the client's calculation |

Values that change on every run (ids, timestamps) are stored as they really were and listed
under `volatile`; the verifying side compares only their type. Secrets are never stored: the
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
  // Send the real secret to the handler; record the placeholder.
  const response = await callHandler(resolvePlaceholders(request, realSecret));

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
  volatile: ["response.body.id"],
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
  (`"request.headers.authorization": "<token:customer-1>"`).
- A secret path that matches nothing, or a value there that is not a string, fails the test: a
  secret that disappears from a response is a change the other side needs to hear about.
- For a request, a test may also pass the placeholder itself and send the real value to the
  code under test, as in the provider example above. Listing the path under `secret` as well
  makes the fixture say so.
- As a safety net, a fixture that contains a string of the shape of a JSON Web Token (`eyJ...`
  in three dot-separated parts, also inside `Bearer eyJ...`) is not written, in update mode
  either, and a stored one fails `check` as `invalid`. Other kinds of secrets (opaque tokens,
  API keys, cookies) have no recognisable shape; only a `secret` path keeps them out.

### Requests and calculations

The other direction works the same way. The consumer calls `verifyRequest` with the request its
real code builds; the provider calls `readRequest` and passes it to the real handler. A table is
read with `readTable` on both sides. See [`example/`](./example) for all three.

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

`check` exits with `0` when there are no problems, `1` when a fixture is unverified, unread or
malformed, and `2` for wrong usage. `CONTRACT_FIXTURES_UPDATE=1` is refused when the environment
variable `CI` is set, because it would turn every difference into a pass. A CI job for one side
should also be triggered by changes to the contracts directory.

## What it does not detect

- **Cases without a fixture.** Only the exchanges somebody recorded are protected.
- **Order and state.** A fixture is one request and one response. Disagreements that only show
  up across several calls, or in a particular server state, are out of scope.
- **Third-party services.** If the provider's tests stub a payment gateway, the fixture reflects
  the stub, not the gateway.
- **Old clients in the field.** The fixtures describe the code in the repository. A released app
  that users have not updated is not checked against a new API.
- **Tests that read without asserting.** See "Keeping reading tests honest".
- **Secrets nobody listed.** Apart from the token shape described under "Secrets", a value is
  only kept out of a fixture when its path is under `secret`. Review new fixtures for it.

It also has no matching DSL, no broker, no multi-step scenarios and no OpenAPI integration, and
it does not depend on an HTTP client or a test framework.

## Measured in practice

The approach was extracted from a prototype on a payment flow of a mobile app: 27 provider
fixtures, 4 consumer fixtures and 1 table of 10 rows. The client-side contract tests took 4 to 8
seconds. The application-independent helper code was 399 lines in 3 files.

## Repository layout

```
spec/            the format (format.md, JSON Schemas) and cases both packages must pass
packages/ts/     @t09tanaka/contract-fixtures
packages/dart/   contract_fixtures
example/         a TypeScript API and a Dart client that share example/contracts
```

`spec/fixtures/` holds language-independent cases (comparison, validation, file output, check).
Both packages run them in their own tests; that is how "the two packages treat a fixture the
same way" is kept true.

## Development

```sh
npm ci && npm run build
npm run lint && npm run typecheck && npm test   # TypeScript package
npm run example                                 # provider side of the example

cd packages/dart && dart pub get
dart format --output=none --set-exit-if-changed . && dart analyze --fatal-infos && dart test
```

## License

MIT
