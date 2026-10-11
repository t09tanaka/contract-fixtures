// The consumer side of a contract, as it would appear in a test file. See the repository's
// example/ directory for a complete, runnable provider and consumer.
import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';

void main() {
  final dir = Directory.systemTemp.createTempSync('contract-fixtures-example-');

  // Normally the provider's tests record this file; here it is written by hand.
  File('${dir.path}/provider/order.out-of-stock.json')
    ..parent.createSync(recursive: true)
    ..writeAsStringSync('''
{
  "format": 1,
  "name": "order.out-of-stock",
  "description": "There are fewer items in stock than were ordered",
  "request": { "method": "POST", "path": "/orders", "body": { "sku": "mug-200", "quantity": 1 } },
  "response": { "status": 409, "body": { "error": "out_of_stock", "available": 0 } }
}
''');

  final contract = ContractFixtures(side: ContractSide.consumer, dir: dir.path);

  // A table from fixture name to what the client must do with that response ...
  const expectations = {
    'order.out-of-stock': 'tell the customer that 0 are left'
  };
  // ... that must name exactly the fixtures on disk.
  contract.assertCovers(FixtureKind.provider, expectations.keys);

  final fixture = contract.readResponse('order.out-of-stock');
  final body = fixture.response.body as Map<String, dynamic>;
  stdout.writeln('${fixture.response.status} ${body['error']}');

  // After the tests: has this side read every fixture?
  final result = checkContracts(dir: dir.path, side: ContractSide.consumer);
  stdout.writeln(formatCheckResult(result));
  dir.deleteSync(recursive: true);
}
