import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:contract_fixtures_dio/contract_fixtures_dio.dart';
import 'package:dio/dio.dart';
import 'package:test/test.dart';

const _json = {'content-type': 'application/json'};

/// A dio that answers through [adapter] and leaves every status to the caller.
Dio _dio(HttpClientAdapter adapter) => Dio(
      BaseOptions(
        baseUrl: 'https://api.example.test',
        validateStatus: (_) => true,
      ),
    )..httpClientAdapter = adapter;

Matcher _refused(String what) => throwsA(
      isA<ContractUsageException>().having(
        (e) => e.message,
        'message',
        'contract_fixtures_dio: the response of the fixture cannot be handed to dio '
            'as it is: $what',
      ),
    );

void main() {
  group('FixtureAdapter', () {
    test('dio receives the status, the headers and the body of the fixture',
        () async {
      const response = ExchangeResponse(
        status: 201,
        headers: {
          'content-type': 'application/json',
          'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
        },
        body: {
          'id': 'ord_81f3',
          'total_minor': 1200,
          'ratio': 0.5,
          'lines': [
            {'sku': 'tea-100', 'note': null, 'gift': false},
          ],
          'text': 'grüner Tee 緑茶',
        },
      );
      final adapter = FixtureAdapter(response);

      final received = await _dio(adapter).post<Object?>('/orders');

      expect(received.statusCode, 201);
      expect(received.data, response.body);
      expect(received.headers.map, {
        'content-type': ['application/json'],
        'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
      });
      expect(adapter.sent.single.path, '/orders');
    });

    test('a response of an error arrives as that error', () async {
      final adapter = FixtureAdapter(
        const ExchangeResponse(
          status: 409,
          headers: {'content-type': 'application/problem+json; charset=utf-8'},
          body: {'error': 'out_of_stock', 'available': 0},
        ),
      );

      final received = await _dio(adapter).post<Object?>('/orders');

      expect(received.statusCode, 409);
      expect(received.data, {'error': 'out_of_stock', 'available': 0});
      // With the default of dio, a status like this one is an exception that holds it.
      final strict = Dio(BaseOptions(baseUrl: 'https://api.example.test'))
        ..httpClientAdapter = adapter;
      await expectLater(
        strict.post<Object?>('/orders'),
        throwsA(
          isA<DioException>()
              .having((e) => e.response?.statusCode, 'status', 409)
              .having((e) => e.response?.data, 'body',
                  {'error': 'out_of_stock', 'available': 0}),
        ),
      );
      expect(adapter.sent, hasLength(2));
    });

    test('a response without a body needs no content-type', () async {
      final adapter = FixtureAdapter(
        const ExchangeResponse(status: 204, headers: {'x-request': 'r-1'}),
      );

      final received = await _dio(adapter).delete<Object?>('/orders/ord_81f3');

      expect(received.statusCode, 204);
      expect(received.data, anyOf(isNull, ''));
      expect(received.headers.map, {
        'x-request': ['r-1'],
      });
    });

    test('a body that is not an object arrives as it is', () async {
      for (final body in <Object>[
        [1, 2, 3],
        'plain',
        12.5,
        true,
      ]) {
        final adapter = FixtureAdapter(
          ExchangeResponse(status: 200, headers: _json, body: body),
        );
        expect((await _dio(adapter).get<Object?>('/x')).data, body);
      }
    });

    test('refuses a body without a JSON content-type, when it is created', () {
      const what =
          'it has a body and no JSON content-type, so dio would not decode it '
          '(record the content-type of the response in the test of the provider)';
      expect(
        () => FixtureAdapter(
          const ExchangeResponse(status: 200, body: {'ok': true}),
        ),
        _refused(what),
      );
      expect(
        () => FixtureAdapter(
          const ExchangeResponse(
            status: 200,
            headers: {'content-type': 'text/plain'},
            body: {'ok': true},
          ),
        ),
        _refused(what),
      );
    });

    test('refuses what it could not hand over unchanged', () {
      expect(
        () => FixtureAdapter(
          const ExchangeResponse(
            status: 200,
            headers: {'content-type': 'application/json', 'x-count': 3},
          ),
        ),
        _refused('the header x-count is not a string or a list of strings'),
      );
      expect(
        () => FixtureAdapter(
          const ExchangeResponse(
            status: 200,
            headers: {
              'set-cookie': ['a=1', 2],
            },
          ),
        ),
        _refused('the header set-cookie is not a string or a list of strings'),
      );
      expect(
        () => FixtureAdapter(
          const ExchangeResponse(status: 200, headers: {'X-Request': 'r-1'}),
        ),
        _refused(
            'the header X-Request is not in lower case, as a fixture has it'),
      );
      expect(
        () => FixtureAdapter(const ExchangeResponse(status: 99)),
        _refused('the status 99 is not one'),
      );
      expect(
        () => FixtureAdapter(
          ExchangeResponse(status: 200, headers: _json, body: double.nan),
        ),
        _refused('its body cannot be encoded as JSON'),
      );
      expect(
        () => FixtureAdapter(
          ExchangeResponse(
            status: 200,
            headers: _json,
            body: {'at': Uri.parse('https://api.example.test')},
          ),
        ),
        _refused('its body cannot be encoded as JSON'),
      );
      expect(
        () => FixtureAdapter(
          const ExchangeResponse(
            status: 200,
            headers: _json,
            body: ExchangeRequest(method: 'GET', path: '/'),
          ),
        ),
        _refused('its body is not the same after it is encoded as JSON'),
      );
    });
  });

  group('FixtureSequenceAdapter', () {
    const expired = ExchangeResponse(
      status: 401,
      headers: _json,
      body: {'error': 'token_invalid'},
    );
    const created = ExchangeResponse(
      status: 201,
      headers: _json,
      body: {'id': 'ord_81f3'},
    );

    test('answers one request after the other, and keeps every request',
        () async {
      final adapter = FixtureSequenceAdapter([expired, created]);
      final dio = _dio(adapter);

      expect((await dio.post<Object?>('/orders')).statusCode, 401);
      final second = await dio.post<Object?>('/orders', data: {'again': true});
      expect(second.statusCode, 201);
      expect(second.data, {'id': 'ord_81f3'});
      expect(adapter.sent, hasLength(2));

      // A request too many fails inside dio, and is counted all the same.
      await expectLater(
        dio.post<Object?>('/orders'),
        throwsA(
          isA<DioException>().having(
            (e) => '${e.error}',
            'error',
            contains('no response left for request 3'),
          ),
        ),
      );
      expect(adapter.sent, hasLength(3));
    });

    test('checks every response when it is created', () {
      expect(
        () => FixtureSequenceAdapter([
          created,
          const ExchangeResponse(status: 200, body: {'ok': true}),
        ]),
        throwsA(isA<ContractUsageException>()),
      );
    });
  });

  group('exchangeRequestFromDio', () {
    test(
        'takes the method, the path with its query, the named headers and the body',
        () async {
      final adapter = FixtureAdapter(const ExchangeResponse(status: 204));
      await _dio(adapter).post<Object?>(
        '/orders',
        queryParameters: {'dry': 'true', 'page': 2},
        data: {'sku': 'tea-100', 'quantity': 2},
        options: Options(
          headers: {'Authorization': 'Bearer t', 'X-Trace': 'abc'},
        ),
      );

      final request = exchangeRequestFromDio(
        adapter.sent.single,
        headers: ['Authorization', 'content-type', 'x-missing'],
      );

      expect(request.toJson(), {
        'method': 'POST',
        'path': '/orders?dry=true&page=2',
        'headers': {
          'authorization': 'Bearer t',
          'content-type': 'application/json',
        },
        'body': {'sku': 'tea-100', 'quantity': 2},
      });
    });

    test('leaves out headers nobody named, and a body that is not there',
        () async {
      final adapter = FixtureAdapter(const ExchangeResponse(status: 204));
      await _dio(adapter).get<Object?>(
        '/orders/ord_81f3/receipt',
        options: Options(headers: {'authorization': 'Bearer t'}),
      );

      expect(exchangeRequestFromDio(adapter.sent.single).toJson(), {
        'method': 'GET',
        'path': '/orders/ord_81f3/receipt',
      });
    });
  });

  group('with a contracts directory', () {
    test('a fixture is read, answered and recorded; the request is verified',
        () async {
      final dir = Directory.systemTemp.createTempSync('contract-fixtures-dio-');
      addTearDown(() => dir.deleteSync(recursive: true));
      ContractFixtures(
        side: ContractSide.provider,
        dir: dir.path,
        update: true,
      ).verifyResponse(
        name: 'order.created',
        description: 'An order is accepted',
        request: const ExchangeRequest(method: 'POST', path: '/orders'),
        response: const ExchangeResponse(
          status: 201,
          headers: _json,
          body: {'id': 'ord_81f3', 'total_minor': 1200},
        ),
      );
      final contract = ContractFixtures(
        side: ContractSide.consumer,
        dir: dir.path,
        update: true,
      );

      final adapter =
          FixtureAdapter(contract.readResponse('order.created').response);
      final received = await _dio(adapter).post<Object?>(
        '/orders',
        data: {'sku': 'tea-100', 'quantity': 2},
      );
      expect(received.data, {'id': 'ord_81f3', 'total_minor': 1200});

      contract.verifyRequest(
        name: 'create-order.request',
        description: 'The request the client sends to place an order',
        request: exchangeRequestFromDio(
          adapter.sent.single,
          headers: ['content-type'],
        ),
      );
      expect(
        contract.readResponse('order.created').request.path,
        '/orders',
      );
      expect(
        File('${dir.path}/consumer/create-order.request.json')
            .readAsStringSync(),
        contains('"content-type": "application/json"'),
      );
      expect(
        checkContracts(dir: dir.path, side: ContractSide.consumer).problems,
        isEmpty,
      );
    });
  });

  test('the version is the one of contract_fixtures, and asks for it', () {
    String version(String path) => RegExp(r'^version: (\S+)$', multiLine: true)
        .firstMatch(File(path).readAsStringSync())!
        .group(1)!;
    final own = File('pubspec.yaml').readAsStringSync();
    expect(version('pubspec.yaml'), version('../dart/pubspec.yaml'));
    expect(own, contains('  contract_fixtures: ^${version('pubspec.yaml')}\n'));
    expect(
      File('CHANGELOG.md').readAsStringSync(),
      contains('## ${version('pubspec.yaml')} '),
    );
  });
}
