/// A dio adapter that answers with the responses of contract fixtures.
///
/// ```dart
/// final adapter = FixtureAdapter(contract.readResponse('order.created').response);
/// final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'))
///   ..httpClientAdapter = adapter;
/// // ... run the client code with `dio`, assert what it made of the response, then:
/// contract.verifyRequest(
///   name: 'create-order.request',
///   description: 'The request the client sends to place an order',
///   request: exchangeRequestFromDio(adapter.sent.single, headers: ['content-type']),
/// );
/// ```
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:dio/dio.dart';

/// Whether two decoded JSON values are the same. Numbers are compared by value.
bool _sameJson(Object? a, Object? b) {
  if (a is Map && b is Map) {
    return a.length == b.length &&
        a.keys.every((key) => b.containsKey(key) && _sameJson(a[key], b[key]));
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!_sameJson(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

/// What the adapter hands to dio for one fixture: the status, the headers and the bytes
/// of the body.
class _Answer {
  _Answer(ExchangeResponse response)
      : status = response.status,
        headers = {
          for (final name in response.headers?.keys ?? const <String>[])
            name: response.headerValues(name),
        } {
    if (response.body != null) {
      try {
        bytes = utf8.encode(jsonEncode(response.body));
      } on JsonUnsupportedObjectError {
        _refuse('its body cannot be encoded as JSON');
      }
    }
    _check(response);
  }

  final int status;
  final Map<String, List<String>> headers;
  Uint8List bytes = Uint8List(0);

  static Never _refuse(String what) => throw ContractUsageException(
        'contract_fixtures_dio: the response of the fixture cannot be handed to dio '
        'as it is: $what',
      );

  /// Fails unless this answer is the response of the fixture: a test must not pass on a
  /// response the fixture does not hold.
  void _check(ExchangeResponse response) {
    const refuse = _refuse;
    if (status < 100 || status > 599) refuse('the status $status is not one');
    final stored = response.headers ?? const <String, dynamic>{};
    for (final name in stored.keys) {
      final value = stored[name];
      final given = value is List ? value : [value];
      if (given.isEmpty || !_sameJson(given, headers[name])) {
        refuse('the header $name is not a string or a list of strings');
      }
      if (name != name.toLowerCase()) {
        refuse('the header $name is not in lower case, as a fixture has it');
      }
    }
    if (response.body == null) return;
    // dio decodes a body only when the response has a JSON content-type. Without this
    // check the client would get the body as a string, or not at all.
    final type = (headers['content-type'] ?? const <String>[]).join();
    if (!type.toLowerCase().contains('json')) {
      refuse(
        'it has a body and no JSON content-type, so dio would not decode it '
        '(record the content-type of the response in the test of the provider)',
      );
    }
    if (!_sameJson(jsonDecode(utf8.decode(bytes)), response.body)) {
      refuse('its body is not the same after it is encoded as JSON');
    }
  }

  ResponseBody toResponseBody() => ResponseBody.fromBytes(
        bytes,
        status,
        headers: {
          for (final header in headers.entries) header.key: [...header.value],
        },
      );
}

/// Answers every request with the response of one fixture, and keeps the requests.
///
/// The response is checked when the adapter is created, not when the client calls: the
/// status, the headers and the body that dio receives are those of the fixture, and a
/// fixture that cannot be handed over as it is throws [ContractUsageException]. That is
/// the case for a body without a JSON `content-type` (dio decodes a body as JSON only
/// when the response says it is JSON), for a header that is not a string or a list of
/// strings, and for a body that JSON cannot carry.
class FixtureAdapter implements HttpClientAdapter {
  FixtureAdapter(this.response) : _answer = _Answer(response);

  /// The response every request is answered with.
  final ExchangeResponse response;
  final _Answer _answer;

  /// The requests the client sent, in order. Pass one to [exchangeRequestFromDio] to
  /// verify it.
  final List<RequestOptions> sent = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    sent.add(options);
    return _answer.toResponseBody();
  }

  @override
  void close({bool force = false}) {}
}

/// Answers the first request with the first response, the second with the second, and so
/// on: for a client that sends more than one request (it gets a 401, signs in again and
/// repeats the request).
///
/// Every response is checked when the adapter is created, like the one of a
/// [FixtureAdapter]. A request for which no response is left throws a [StateError] inside
/// dio, which wraps it; client code that turns every failure into the same outcome would
/// hide that. So end the test with the number of requests it expects:
/// `expect(adapter.sent, hasLength(2))`. [sent] holds every request, also one too many.
class FixtureSequenceAdapter implements HttpClientAdapter {
  FixtureSequenceAdapter(Iterable<ExchangeResponse> responses)
      : _adapters = [
          for (final response in responses) FixtureAdapter(response),
        ];

  final List<FixtureAdapter> _adapters;

  /// The requests the client sent, in order, also one the adapter had no response for.
  final List<RequestOptions> sent = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    sent.add(options);
    if (sent.length > _adapters.length) {
      throw StateError('no response left for request ${sent.length}');
    }
    return _adapters[sent.length - 1]
        .fetch(options, requestStream, cancelFuture);
  }

  @override
  void close({bool force = false}) {}
}

/// A request dio sent, in the form `verifyRequest` takes.
///
/// The path is the path of the URL, with the query string if there is one. Of the headers
/// only those named in [headers] are taken (in any case; they are written in lower case),
/// because dio adds some of its own, such as `content-length`: name the ones that are part
/// of the agreement. A header the request does not have is left out. The body is
/// `options.data`, which has to be something JSON can carry.
ExchangeRequest exchangeRequestFromDio(
  RequestOptions options, {
  Iterable<String> headers = const [],
}) {
  final uri = options.uri;
  final wanted = {for (final name in headers) name.toLowerCase()};
  final taken = <String, dynamic>{};
  for (final header in options.headers.entries) {
    final name = header.key.toLowerCase();
    final value = header.value;
    if (!wanted.contains(name) || value == null) continue;
    taken[name] = value is List ? [for (final one in value) '$one'] : '$value';
  }
  return ExchangeRequest(
    method: options.method.toUpperCase(),
    path: uri.hasQuery ? '${uri.path}?${uri.query}' : uri.path,
    headers: taken.isEmpty ? null : taken,
    body: options.data,
  );
}
