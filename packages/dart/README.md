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

Where the provider listed a secret, the fixture holds a placeholder such as
`<token:session-1>`. Put a value in before the client code reads the response:

```dart
final fixture = contract.readResponse('session.created');
final body = resolvePlaceholders(fixture.response.body, (kind, name) => 'test $kind of $name');
```

A request this side builds with a real credential in it is verified with `secret`; the file
gets the placeholder, never the real value:

```dart
contract.verifyRequest(
  name: 'create-order.request',
  description: 'The request the client sends to place an order',
  request: ExchangeRequest(method: request.method, path: request.path, headers: request.headers, body: request.body),
  secret: {'request.headers.authorization': '<token:customer-1>'},
);
```

### Provider side

```dart
final contract = ContractFixtures(side: ContractSide.provider, dir: '../contracts');

contract.verifyResponse(
  name: 'order.created',
  description: 'An order is accepted',
  request: request,
  response: ExchangeResponse(status: response.statusCode, body: jsonDecode(response.body)),
  // Values that change, each with the shape it keeps.
  volatile: [
    VolatilePattern('response.body.id', r'^ord_[a-z0-9]+$'),
    VolatilePattern('response.body.**.created_at', r'^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$'),
  ],
);

// A response with a secret in it: the file gets the placeholder, never the real value.
contract.verifyResponse(
  name: 'session.created',
  description: 'Signing in returns an access token',
  request: signIn,
  response: ExchangeResponse(status: response.statusCode, body: jsonDecode(response.body)),
  secret: {'response.body.access_token': '<token:session-1>'},
);

final recorded = contract.readRequest('create-order.request').request;
final headers = resolvePlaceholders(recorded.headers ?? {}, (kind, name) => secrets['$kind:$name']);
```

## API

`ContractFixtures({required side, dir, update})`:

| Member | Side | What it does |
|---|---|---|
| `verifyResponse(name:, description:, request:, response:, volatile:, secret:)` | provider | Compares with `provider/<name>.json`; throws `ContractMismatch` listing the differences. Writes the file in update mode. |
| `verifyRequest(name:, description:, request:, volatile:, secret:)` | consumer | The same for `consumer/<name>.json`. |
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
- `volatile` lists the values that change between runs. An entry is a path
  (`'response.body.note'`: only the JSON type is compared) or a
  `VolatilePattern(path, pattern)` (a string that must match the pattern as a whole). In a
  path, `*` is one key or index and `**` any number of them: `response.body.**.created_at`. A
  path that ends in `**` compares keys and types of everything below and cannot have a
  pattern. `request.path` can be volatile too:
  `VolatilePattern('request.path', r'^/orders/ord_[a-z0-9]+/receipt$')`. Patterns are a subset
  of ECMAScript regular expressions that the package matches itself (not with `RegExp`); see
  `spec/format.md`. A value that does not match is a difference, and is never written in
  update mode.
- `secret` maps paths to placeholders, for example
  `{'response.body.access_token': '<token:session-1>'}`. The string at each path is replaced
  by its placeholder before anything is compared, printed or written, so the real value is not
  in the file, in a difference, in an exception or in the ledger. A path replaces a whole
  value (`*` for one key or index, no `**`); for a secret inside a string, such as
  `Bearer ...` or a cookie, make the whole header value the secret. A path that matches
  nothing, or a value that is not a string, throws `ContractFixtureException`. So does update
  mode when the stored fixture lists a secret path that the test does not pass: remove the
  path from the stored file by hand if it is no longer a secret.
- A fixture that contains a string of the shape of a JSON Web Token is not written (in update
  mode either) and fails `check`; list its path in `secret`. Other kinds of secrets are not
  recognised.
- `ExchangeResponse(status:, headers:, body:)` records response headers like request headers:
  pass the headers that are part of the agreement. A value is a `String`, or a `List<String>`
  for a header that is sent more than once (`set-cookie`, compared in order). `headers` is a
  `Map<String, dynamic>?`, so a `Map<String, String>`, a `Map<String, List<String>>` or a
  decoded JSON map can be passed as it is; a value of another type fails the verify. Paths
  reach into the list: `response.headers.set-cookie.0`. A body that is not JSON is not
  recorded; pass the status and the headers only.
- On the reading side, `fixture.response.headers` is the stored map, and
  `fixture.response.headerValues('set-cookie')` gives the values of one header as a
  `List<String>` (one element for a string, empty when the header is absent). The same on
  `ExchangeRequest`. Code that needs a `Map<String, String>` builds it from that, joining or
  picking the values the way its HTTP library would:
  `{for (final name in headers.keys) name: request.headerValues(name).join(', ')}`. Do not
  join `set-cookie`; its values contain commas.
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
