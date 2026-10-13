// A client built on dio, answered by a fixture. See example/consumer in the repository for
// a complete app with its contract tests.
import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:contract_fixtures_dio/contract_fixtures_dio.dart';
import 'package:dio/dio.dart';

Future<void> main() async {
  final dir = Directory.systemTemp.createTempSync('contract-fixtures-dio-');

  // Normally the provider's tests record this file; here it is written by hand.
  File('${dir.path}/provider/order.out-of-stock.json')
    ..parent.createSync(recursive: true)
    ..writeAsStringSync('''
{
  "format": 1,
  "name": "order.out-of-stock",
  "description": "There are fewer items in stock than were ordered",
  "request": { "method": "POST", "path": "/orders", "body": { "sku": "mug-200", "quantity": 1 } },
  "response": {
    "status": 409,
    "headers": { "content-type": "application/json" },
    "body": { "error": "out_of_stock", "available": 0 }
  }
}
''');

  final contract = ContractFixtures(
    side: ContractSide.consumer,
    dir: dir.path,
    update: true,
  );

  // The adapter answers with the fixture; dio decodes the body as it would in the app.
  final adapter =
      FixtureAdapter(contract.readResponse('order.out-of-stock').response);
  final dio = Dio(
    BaseOptions(
      baseUrl: 'https://api.example.test',
      validateStatus: (_) => true,
    ),
  )..httpClientAdapter = adapter;

  final response = await dio.post<Map<String, dynamic>>(
    '/orders',
    data: {'sku': 'mug-200', 'quantity': 1},
  );
  stdout.writeln('${response.statusCode}: ${response.data?['available']} left');

  // The request the client really sent becomes a consumer fixture.
  final verified = contract.verifyRequest(
    name: 'create-order.request',
    description: 'The request the client sends to place an order',
    request: exchangeRequestFromDio(
      adapter.sent.single,
      headers: ['content-type'],
    ),
  );
  stdout
      .writeln('${verified.file} ${verified.written ? 'written' : 'verified'}');

  dir.deleteSync(recursive: true);
}
