# contract_fixtures_dio

[![CI](https://github.com/t09tanaka/contract-fixtures/actions/workflows/ci.yml/badge.svg)](https://github.com/t09tanaka/contract-fixtures/actions/workflows/ci.yml)

A [dio](https://pub.dev/packages/dio) adapter that answers with the responses of
[`contract_fixtures`](https://pub.dev/packages/contract_fixtures) fixtures, and a helper that
turns the request dio sent into the form `verifyRequest` takes.

A client built on dio is tested through dio: the client builds the request, dio decodes the
response, and the client's own code decides what to do with it. A test that replaces the
whole API client with a mock checks none of that. `contract_fixtures` itself has no
dependencies; this package is the part that knows dio.

## Install

```sh
dart pub add --dev contract_fixtures contract_fixtures_dio
```

Dart 3.5 or later, dio 5. The version is the one of `contract_fixtures`.

## Use

```dart
import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:contract_fixtures_dio/contract_fixtures_dio.dart';
import 'package:dio/dio.dart';

final contract = ContractFixtures(side: ContractSide.consumer, dir: '../contracts');

final adapter = FixtureAdapter(contract.readResponse('order.created').response);
final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'))..httpClientAdapter = adapter;

// ... run the client code with `dio`, assert what it made of the response, then:
contract.verifyRequest(
  name: 'create-order.request',
  description: 'The request the client sends to place an order',
  request: exchangeRequestFromDio(
    adapter.sent.single,
    headers: ['authorization', 'content-type'],
  ),
  secret: {'request.headers.authorization': '<token:customer-1>'},
);
```

[`example/consumer`](https://github.com/t09tanaka/contract-fixtures/tree/main/example/consumer)
in the repository is an app tested this way.

## API

| | |
|---|---|
| `FixtureAdapter(response)` | An `HttpClientAdapter` that answers every request with the `ExchangeResponse` of one fixture. `sent` holds the `RequestOptions` of the requests, in order. |
| `FixtureSequenceAdapter(responses)` | Answers the first request with the first response, the second with the second, and so on. `sent` holds every request, also one the adapter had no response for. |
| `exchangeRequestFromDio(options, headers: [...])` | The `ExchangeRequest` of a request dio sent: method, path with query string, the headers that are named, and `options.data` as the body. |

### What an adapter checks

An adapter looks at its response **when it is created**, before the client runs. dio then
receives the status, the headers and the body of the fixture, and a fixture that cannot be
handed over as it is throws `ContractUsageException`:

- **A body without a JSON `content-type`.** dio decodes a body as JSON only when the response
  says it is JSON. Without the header the client's code gets a string where it expects a
  map, and code that turns every failure into the same outcome then passes a test of an
  error response without having read the error. The header is part of the agreement, so
  **record it in the provider's test** (`responseHeaders: ["content-type"]` with
  `exchangeFromTestResponse` of the TypeScript package; `headers: {'content-type': ...}` in
  an `ExchangeResponse`), and it arrives here from the fixture.
- A header that is not a string or a list of strings, or whose name is not in lower case.
- A body that JSON cannot carry, or that is another value after it is encoded.

A fixture that `readResponse` returned can only fail the first of these; the others guard a
response a test assembled by hand (after `resolvePlaceholders`, for example).

### Several requests in one test

A client that gets a 401, signs in again and repeats the request needs one response after
the other:

```dart
final adapter = FixtureSequenceAdapter([
  contract.readResponse('order.token-invalid').response,
  contract.readResponse('order.created').response,
]);

// ... run the client code, assert what it made of the responses, then:
expect(adapter.sent, hasLength(2));
```

Do not leave the last line out. The error for a request too many is thrown inside dio, which
wraps it, and client code that turns every failed request into "failed" then passes a test
that expects "failed"; counting the requests afterwards does not depend on what the client
does with the error. Each response is still a fixture of its own, read and recorded one by
one.

### The request

`exchangeRequestFromDio` takes only the headers it is told to take, because dio adds some of
its own (`content-length`): name the ones that are part of the agreement. Names are matched
in any case and written in lower case; a header the request does not have is left out. A
real credential in a header is kept out of the fixture with `secret`, as in every verify.

With the default `validateStatus` of dio, a response with a status of 400 or more reaches
the client as a `DioException` that holds it. That is what the app sees too, so the adapter
does not change it.

## License

MIT
