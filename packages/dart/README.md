# contract_fixtures

[![CI](https://github.com/t09tanaka/contract-fixtures/actions/workflows/ci.yml/badge.svg)](https://github.com/t09tanaka/contract-fixtures/actions/workflows/ci.yml)

Shared request/response fixtures that keep an API and its clients in step. The provider's tests
verify the fixtures against real responses; the consumer's tests read them.

This is the Dart package. The idea, the workflow and the limits are described in the
[repository README](https://github.com/t09tanaka/contract-fixtures#readme); the file format is
in [`spec/format.md`](https://github.com/t09tanaka/contract-fixtures/blob/main/spec/format.md).
A TypeScript package with the same core API reads and writes the same files. For a project
that already has tests, see the
[adoption guide](https://github.com/t09tanaka/contract-fixtures/blob/main/docs/adoption.md).

- Pure Dart (uses `dart:io`), no dependencies. Works under `dart test` and `flutter test`.
- Independent of the test framework: failures are thrown as ordinary exceptions.
- Fixtures are read from the file system relative to the working directory (the package root
  during tests), so they do not have to be registered as assets.

## Install

```sh
dart pub add --dev contract_fixtures
```

To install a version that is not on pub.dev, from the repository, see
[Install](https://github.com/t09tanaka/contract-fixtures#install)
in the repository README.

A Flutter project that keeps its tests under `lib/`, next to the sources, needs the package
under `dependencies`, not `dev_dependencies` (`dart pub add contract_fixtures`): the lint
`depend_on_referenced_packages` does not accept an import from `lib/` of a package that is
only a dev dependency.

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
| `verifyResponse(name:, description:, request:, response:, volatile:, secret:)` | provider | Compares with `provider/<name>.json`; throws `ContractMismatch` listing the differences. Writes the file in update mode. Returns a `Verified` (`file`, `written`). |
| `verifyRequest(name:, description:, request:, volatile:, secret:)` | consumer | The same for `consumer/<name>.json`. |
| `readResponse(name)` | consumer | Reads and validates `provider/<name>.json`; returns a `ProviderFixture`. |
| `readRequest(name)` | provider | Reads and validates `consumer/<name>.json`; returns a `ConsumerFixture`. |
| `readTable(name)` | both | Reads and validates `tables/<name>.json`; returns a `TableFixture`. |
| `list(kind, prefix:)` | both | Sorted fixture names of a `FixtureKind`. |
| `assertCovers(kind, names, prefix:)` | both | Throws `ContractCoverageException` unless `names` are exactly the fixtures on disk (those that start with `prefix`). Returns the names it looked at. |
| `assertPrefixesCover(kind, prefixes)` | both | Throws `ContractCoverageException` unless every fixture starts with one of `prefixes` and every prefix has a fixture. Use it once next to several `assertCovers` with a prefix. Returns the names it looked at. |

Calling a method from the wrong side throws `ContractUsageException`. A missing or invalid
fixture throws `ContractFixtureException`.

- `dir` defaults to the environment variable `CONTRACT_FIXTURES_DIR`. It is looked up when
  the directory is first used (a verify, a read, `list`, `dir` itself), not by the
  constructor: a tool that only loads the test files, to collect other tests or to run
  mutation tests on a part of them, does not need the variable. A missing directory throws
  `ContractUsageException` at that first use.
- `warn` (a function that takes a `String`) receives a note that is not a failure. There is one:
  update mode wrote a fixture with a 5xx over one that held another status, which is more
  often a test application that differs from the deployed one than a change of the API. By
  default the note is one line on standard error.
- A line of a difference shows at most 200 UTF-16 code units of a value (`... (<n> more)` after
  that), and the difference of the status of a response comes first.
- `update` defaults to `CONTRACT_FIXTURES_UPDATE=1`. In update mode a verify writes a missing or
  differing fixture and leaves a fixture that already agrees untouched. The environment variable
  is refused when `CI` is `true` or `1`.
- `volatile` lists the values that change between runs. An entry is a path
  (`'response.body.note'`: only the JSON type is compared) or a
  `VolatilePattern(path, pattern)` (a string that must match the pattern as a whole). A map
  works too, `{'path': ..., 'pattern': ...}`, and `{'path': ...}` alone is the path. In a
  path, `*` is one key or index and `**` any number of them: `response.body.**.created_at`. A
  path that ends in `**` compares keys and types of everything below and cannot have a
  pattern. `request.path` can be volatile too:
  `VolatilePattern('request.path', r'^/orders/ord_[a-z0-9]+/receipt$')`. Patterns are a subset
  of ECMAScript regular expressions that the package matches itself (not with `RegExp`); see
  `spec/format.md`. A value that does not match is a difference, and is never written in
  update mode. For a value that is a string in one place and `null` in another, pass
  `VolatilePattern('response.body.**.closed_at', pattern, nullable: true)`: it accepts a
  string that matches or `null`, and which of the two it is may change between runs.
- When a volatile path of the test matches nothing in what the test passes, the verify still
  compares: the `ContractMismatch` lists the differences first (the status and the keys of a
  response that is another one altogether) and the paths after them, also as `unmatched`.
  Such a fixture is never written.
- `secret` maps paths to placeholders, for example
  `{'response.body.access_token': '<token:session-1>'}`. The string at each path is replaced
  by its placeholder before anything is compared, printed or written, so the real value is not
  in the file, in a difference, in an exception or in the ledger. A path replaces a whole
  value (`*` for one key or index, no `**`); for a secret inside a string, such as
  `Bearer ...` or a cookie, make the whole header value the secret. A path that matches
  nothing, or a value that is not a string, throws `ContractFixtureException`. So does update
  mode when the stored fixture lists a secret path that the test does not pass: remove the
  path from the stored file by hand if it is no longer a secret.
- A helper that verifies many requests names a credential that only some of them carry (no
  `authorization` or `cookie` on a request that is not signed in). For such a path pass
  `OptionalSecret('<token:customer-1>')` in the place of the placeholder: where the path
  matches nothing the entry is left out, and where it matches it is a secret like any other.
  The default stays strict, because a secret that disappears is a change. The fixture holds
  path and placeholder in both cases.
- A project whose lint asks for an `expect` in every test can end a test in one: the helpers
  that throw on failure return what they did.
  `expect(contract.verifyResponse(...).file, 'provider/order.created.json')`, and
  `expect(contract.assertCovers(FixtureKind.provider, expectations.keys), isNotEmpty)`.
- A fixture that contains a string of the shape of a JSON Web Token is not written (in update
  mode either) and fails `check`; list its path in `secret`. Other kinds of secrets are not
  recognised, unless the contracts directory has a `config.json` that describes them:
  `{ "format": 1, "forbidden": ["sec_live_[A-Za-z0-9]+"] }` refuses every string in which one
  of the patterns matches, the same way. `readConfig(dir)` and `validateConfig(text)` return
  what the file says and how it does not follow the format.
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
`formatCheckResult` (the result has `problems` and `hints`), `summarizeContracts`,
`formatSummary`, `resetLedger`, `canonicalJson`, `compactJson`, `readConfig`,
`validateConfig`, `runCli`.

## HTTP in tests

The package does not depend on an HTTP library. A fixture reaches the client's real code
through the test double the library already has; the lines below are all it takes. In both
cases the client builds the request and decodes the response itself, which is the point: a
test that replaces the whole API client with a mock checks neither.

### `package:http`

```dart
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final sent = <http.Request>[];
final client = MockClient((request) async {
  sent.add(request);
  final response = contract.readResponse('order.created').response;
  return http.Response.bytes(
    response.body == null ? const [] : utf8.encode(jsonEncode(response.body)),
    response.status,
    headers: {
      for (final name in response.headers?.keys ?? const <String>[])
        name: response.headerValues(name).join(', '),
    },
  );
});

// ... run the client code with `client`, assert what it made of the response, then:
final request = sent.single;
contract.verifyRequest(
  name: 'create-order.request',
  description: 'The request the client sends to place an order',
  request: ExchangeRequest(
    method: request.method,
    path: request.url.hasQuery
        ? '${request.url.path}?${request.url.query}'
        : request.url.path,
    headers: request.headers,
    body: request.body.isEmpty ? null : jsonDecode(request.body),
  ),
  secret: {'request.headers.authorization': '<token:customer-1>'},
);
```

`http.Response.bytes` with UTF-8, not `http.Response(text, ...)`: the latter encodes as
Latin-1 unless a `content-type` header says otherwise. `package:http` has one value per header
name, so the values of a repeated header are joined, as it does itself for a real response;
several `set-cookie` values cannot be taken apart again after that.

### dio

```dart
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

class FixtureAdapter implements HttpClientAdapter {
  FixtureAdapter(this.response);

  final ExchangeResponse response;
  final sent = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    sent.add(options);
    // dio decodes a body only when the response has a JSON content-type. Without this
    // check the client would get the body as a string, or not at all.
    final type = response.headerValues('content-type').join();
    if (response.body != null && !type.toLowerCase().contains('json')) {
      throw StateError(
        'the fixture has a body and no JSON content-type, so dio would not decode it: '
        'record the content-type of the response in the test of the provider',
      );
    }
    return ResponseBody.fromBytes(
      response.body == null ? const [] : utf8.encode(jsonEncode(response.body)),
      response.status,
      headers: {
        for (final name in response.headers?.keys ?? const <String>[])
          name: response.headerValues(name),
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

final adapter = FixtureAdapter(contract.readResponse('order.created').response);
final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'))..httpClientAdapter = adapter;

// ... run the client code with `dio`, then:
final options = adapter.sent.single;
contract.verifyRequest(
  name: 'create-order.request',
  description: 'The request the client sends to place an order',
  request: ExchangeRequest(
    method: options.method,
    path: options.uri.hasQuery ? '${options.uri.path}?${options.uri.query}' : options.uri.path,
    headers: {
      for (final name in const ['authorization', 'content-type'])
        if (options.headers[name] != null) name: options.headers[name],
    },
    body: options.data,
  ),
  secret: {'request.headers.authorization': '<token:customer-1>'},
);
```

A test in which the client sends more than one request (it gets a 401, signs in again and
repeats the request) needs one response after the other. Wrap one `FixtureAdapter` per
response and hand them out in order:

```dart
class FixtureSequenceAdapter implements HttpClientAdapter {
  FixtureSequenceAdapter(Iterable<ExchangeResponse> responses)
      : _adapters = [for (final response in responses) FixtureAdapter(response)];

  final List<FixtureAdapter> _adapters;
  final sent = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    // Every request is kept, also one the test has no response for.
    sent.add(options);
    if (sent.length > _adapters.length) {
      throw StateError('no response left for request ${sent.length}');
    }
    return _adapters[sent.length - 1].fetch(options, requestStream, cancelFuture);
  }

  @override
  void close({bool force = false}) {}
}

final adapter = FixtureSequenceAdapter([
  contract.readResponse('order.token-invalid').response,
  contract.readResponse('order.created').response,
]);

// ... run the client code, assert what it made of the responses, then:
expect(adapter.sent, hasLength(2));
```

Do not leave the last line out. The error for a request too many is thrown inside the HTTP
client, which wraps it, and client code that turns every failed request into "failed" then
passes a test that expects "failed"; counting the requests afterwards does not depend on what
the client does with the error. Each response is still a fixture of its own, read and
recorded one by one.

dio decodes a body as JSON only when the response has a JSON `content-type`. A client built
on dio relies on that, so the header is part of the agreement: **record it in the provider's
test** (`responseHeaders: ["content-type"]` with `exchangeFromTestResponse`; `headers:
{'content-type': ...}` in an `ExchangeResponse`), and it arrives here from the fixture.
Without it the client's code gets a string where it expects a map, and code that turns every
failure into the same outcome then passes a test of an error response without having read
the error. The adapter above throws in that case instead of answering. The request headers
of dio include `content-length`; name the ones that matter, as above.

### Numbers

`jsonDecode` gives an `int` for `10` and a `double` for `10.5`, so `json['amount'] as double`
works for one response and throws for the next. An API that sends amounts or ratios will send
a whole number sooner or later. Read numbers as `num`:
`(json['amount'] as num).toDouble()`. A fixture with a whole number in such a field is a good
one to have.

## Command line

```sh
dart run contract_fixtures reset --side consumer --dir ../contracts   # before the tests
dart run contract_fixtures check --side consumer --dir ../contracts   # after the tests
dart run contract_fixtures summary --dir ../contracts                 # any time; --depth 2 looks one level deeper
dart run contract_fixtures --version                                  # also -v; --help or -h for the help
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
contract_fixtures reset (consumer side): OK (no entries in .ledger/consumer.jsonl)
contract_fixtures check (consumer side): OK (4 fixture(s), all verified or read by this side's tests)
```

Run `check` after all tests of the side: it always looks at every fixture. With problems it
prints a report to standard error. When the ledger suggests why fixtures were not touched (it
is missing or empty, only the other side has one, a part of the tests ran, it names files that
are gone), the report ends with a line that starts with `Hint:`. When the ledger has no
entries at all, one line gives the number of fixtures in the place of the whole list.

`summary` prints one line per fixture, to compare them side by side: the request, the status,
and the keys of the response body with their types. It takes no `--side` and does not touch
the ledger. `--depth 2` opens the objects inside a body as well (`{data: object}` becomes
`{data: {id: string, ...}}`), up to `--depth 9`. An array that is reached shows its first
element in brackets (`[{id: string}]`, `[]` when empty, `[mixed]` for more than one type).

```
FIXTURE                        REQUEST       STATUS  RESPONSE BODY
provider/order.created         POST /orders  201     {created_at: string, id: string, lines: array, status: string, total_minor: number}
provider/order.out-of-stock    POST /orders  409     {error: string}
consumer/create-order.request  POST /orders  -       -
tables/order-total             -             -       2 row(s)
```

### Starting the commands faster

`dart run contract_fixtures` looks at the dependencies of the project and starts the Dart VM on
every call, which takes far longer than the command itself. Where the commands run often (a
script that watches files, a hook before every commit, several contracts directories), compile
them once into an executable of the project. A file of three lines is the entry point:

```dart
// tool/contract_fixtures.dart
import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';

void main(List<String> arguments) {
  exitCode = runCli(arguments, out: stdout.writeln, err: stderr.writeln);
}
```

```sh
mkdir -p build
dart compile exe tool/contract_fixtures.dart -o build/contract_fixtures
build/contract_fixtures reset --side consumer --dir ../contracts
dart test
build/contract_fixtures check --side consumer --dir ../contracts
```

The commands, their output and their exit codes are the same; only the start is shorter.

- **The executable is the version it was built from.** It is compiled from the project, so
  that is the version the dependencies are resolved to at that moment (after `dart pub get`,
  the one in `pubspec.lock`), not the one after the next `dart pub upgrade`. Build it again
  whenever the lock file is newer, and resolve first: `dart compile exe` compiles what was
  resolved last, so a lock file that changed without `dart pub get` would give an executable
  of the old version that looks new. For instance at the top of the script that runs the tests:
  `test build/contract_fixtures -nt pubspec.lock || { dart pub get && mkdir -p build && dart compile exe tool/contract_fixtures.dart -o build/contract_fixtures; }`.
  `build/contract_fixtures --version` says what it is. The lock file changes with the version
  of a dependency from pub.dev or from git; with a `path` dependency it does not change when
  the source of the package does, so build again after changing that. Do not commit the
  executable: put `build/` into `.gitignore`.
- **In CI, stay with `dart run`.** A job runs `reset` once and `check` once; compiling takes
  longer than the two starts it saves. The compiled executable pays off from a handful of
  calls on.
- **`dart pub global activate contract_fixtures` is not the same thing.** It installs a version
  of its own, outside the project. The helpers in the tests then come from `pubspec.lock` and
  the commands from somewhere else, and a difference between the two versions shows up as a
  `check` that disagrees with the tests. Use the executable of the project, or `dart run`.

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
