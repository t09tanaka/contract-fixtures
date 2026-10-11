# contract_fixtures

Shared request/response fixtures that keep an API and its clients in step. The provider's tests
verify the fixtures against real responses; the consumer's tests read them.

This is the Dart package. The idea, the workflow and the limits are described in the
[repository README](https://github.com/t09tanaka/contract-fixtures#readme); the file format is
in [`spec/format.md`](https://github.com/t09tanaka/contract-fixtures/blob/main/spec/format.md).
A TypeScript package with the same API reads and writes the same files.

- Pure Dart (uses `dart:io`), no dependencies. Works under `dart test` and `flutter test`.
- Independent of the test framework: failures are thrown as ordinary exceptions.
- Fixtures are read from the file system relative to the working directory (the package root
  during tests), so they do not have to be registered as assets.

## Install

```sh
dart pub add --dev contract_fixtures
```

## Use

```dart
import 'package:contract_fixtures/contract_fixtures.dart';

// One object per test file.
final contract = ContractFixtures(side: ContractSide.consumer, dir: '../contracts');
```

### Consumer side

```dart
/// Fixture name -> what the app must do when it receives that response.
const expectations = {
  'order.created': 'placed, total 1200',
  'order.out-of-stock': 'out of stock, 0 left',
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

  test('create-order.request', () {
    final request = buildCreateOrderRequest(authorization: '<token:customer-1>', sku: 'tea-100', quantity: 2);
    contract.verifyRequest(
      name: 'create-order.request',
      description: 'The request the client sends to place an order',
      request: ExchangeRequest(
        method: request.method,
        path: request.path,
        headers: request.headers,
        body: request.body,
      ),
    );
  });

  for (final row in contract.readTable('order-total').rows) {
    test(row['case'], () { /* assert this side's calculation */ });
  }
}
```

### Provider side

```dart
final contract = ContractFixtures(side: ContractSide.provider, dir: '../contracts');

contract.verifyResponse(
  name: 'order.created',
  description: 'An order is accepted',
  request: request,
  response: ExchangeResponse(status: response.statusCode, body: jsonDecode(response.body)),
  volatile: ['response.body.id', 'response.body.created_at'],
);

final recorded = contract.readRequest('create-order.request').request;
final headers = resolvePlaceholders(recorded.headers ?? {}, (kind, name) => secrets['$kind:$name']);
```

## API

`ContractFixtures({required side, dir, update})`:

| Member | Side | What it does |
|---|---|---|
| `verifyResponse(name:, description:, request:, response:, volatile:)` | provider | Compares with `provider/<name>.json`; throws `ContractMismatch` listing the differences. Writes the file in update mode. |
| `verifyRequest(name:, description:, request:, volatile:)` | consumer | The same for `consumer/<name>.json`. |
| `readResponse(name)` | consumer | Reads and validates `provider/<name>.json`; returns a `ProviderFixture`. |
| `readRequest(name)` | provider | Reads and validates `consumer/<name>.json`; returns a `ConsumerFixture`. |
| `readTable(name)` | both | Reads and validates `tables/<name>.json`; returns a `TableFixture`. |
| `list(kind, prefix:)` | both | Sorted fixture names of a `FixtureKind`. |
| `assertCovers(kind, names, prefix:)` | both | Throws `ContractCoverageException` unless `names` are exactly the fixtures on disk. |

Calling a method from the wrong side throws `ContractUsageException`. A missing or malformed
fixture throws `ContractFixtureException`.

- `dir` defaults to the environment variable `CONTRACT_FIXTURES_DIR`.
- `update` defaults to `CONTRACT_FIXTURES_UPDATE=1`. In update mode a verify writes a missing or
  differing fixture and leaves a fixture that already agrees untouched. The environment variable
  is refused when `CI` is set.
- Header names are lower-cased before comparing and writing. A `null` body means "no body".
- Request and response bodies are whatever `jsonEncode` accepts. Numbers are compared by value,
  so `1` and `1.0` are equal.

Top-level functions: `resolvePlaceholders`, `parsePlaceholder`, `differences`,
`formatDifferences`, `validateFixture`, `validateFixtureValue`, `checkContracts`,
`formatCheckResult`, `resetLedger`, `canonicalJson`, `compactJson`, `runCli`.

## Command line

```sh
dart run contract_fixtures reset --side consumer --dir ../contracts   # before the tests
dart run contract_fixtures check --side consumer --dir ../contracts   # after the tests
```

`check` exits with `0` when every fixture follows the format and was verified or read by this
side's tests since the reset, `1` otherwise, and `2` for wrong usage. `--dir` defaults to
`CONTRACT_FIXTURES_DIR`.

## License

MIT
