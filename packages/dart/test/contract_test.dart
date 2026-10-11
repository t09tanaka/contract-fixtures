import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:test/test.dart';

import 'helpers.dart';

const _request = ExchangeRequest(
  method: 'POST',
  path: '/orders',
  headers: {'authorization': '<token:customer-1>'},
  body: {'sku': 'mug-200', 'quantity': 1},
);

void main() {
  group('ContractFixtures', () {
    test('needs a directory', () {
      expect(
        () => ContractFixtures(side: ContractSide.provider, environment: {}),
        throwsA(isA<ContractUsageException>()),
      );
    });

    test('takes the directory and update mode from the environment', () {
      final dir = tempDir();
      final contract = ContractFixtures(
        side: ContractSide.provider,
        environment: {
          'CONTRACT_FIXTURES_DIR': dir,
          'CONTRACT_FIXTURES_UPDATE': '1',
        },
      );
      expect(contract.dir, Directory(dir).absolute.path);
      expect(contract.update, isTrue);
      expect(
        ContractFixtures(
          side: ContractSide.provider,
          dir: dir,
          environment: {'CONTRACT_FIXTURES_UPDATE': 'true'},
        ).update,
        isFalse,
      );
      expect(
        ContractFixtures(
          side: ContractSide.provider,
          update: false,
          environment: {
            'CONTRACT_FIXTURES_DIR': dir,
            'CONTRACT_FIXTURES_UPDATE': '1',
          },
        ).update,
        isFalse,
      );
    });

    test('only lets the provider side verify responses and read requests', () {
      final dir = copyOfContracts();
      final consumer = ContractFixtures(side: ContractSide.consumer, dir: dir);
      expect(
        () => consumer.verifyResponse(
          name: 'order.out-of-stock',
          description: 'The item is out of stock',
          request: _request,
          response: const ExchangeResponse(status: 409),
        ),
        throwsA(isA<ContractUsageException>()),
      );
      expect(
        () => consumer.readRequest('create-order.request'),
        throwsA(isA<ContractUsageException>()),
      );
      expect(ledgerLines(dir, 'consumer'), isEmpty);
    });

    test('only lets the consumer side verify requests and read responses', () {
      final dir = copyOfContracts();
      final provider = ContractFixtures(side: ContractSide.provider, dir: dir);
      expect(
        () => provider.verifyRequest(
          name: 'create-order.request',
          description: 'x',
          request: _request,
        ),
        throwsA(isA<ContractUsageException>()),
      );
      expect(
        () => provider.readResponse('order.created'),
        throwsA(isA<ContractUsageException>()),
      );
      expect(ledgerLines(dir, 'provider'), isEmpty);
    });

    test('reads a response and records it', () {
      final dir = copyOfContracts();
      final fixture = ContractFixtures(side: ContractSide.consumer, dir: dir)
          .readResponse('order.created');
      expect(fixture.name, 'order.created');
      expect(fixture.response.status, 201);
      expect((fixture.response.body as Map<String, dynamic>)['id'], 'ord_81f3');
      expect(fixture.request.headers, {'authorization': '<token:customer-1>'});
      expect(fixture.volatile, hasLength(3));
      expect(ledgerLines(dir, 'consumer'), [
        '{"side":"consumer","action":"read","file":"provider/order.created.json"}',
      ]);
    });

    test('reads a request and a table and records them', () {
      final dir = copyOfContracts();
      final provider = ContractFixtures(side: ContractSide.provider, dir: dir);
      final fixture = provider.readRequest('create-order.request');
      expect(fixture.request.path, '/orders');
      expect(fixture.request.method, 'POST');
      expect(fixture.volatile, isEmpty);
      final table = provider.readTable('order-total');
      expect(table.rows.map((row) => row['expected_minor']), [1200, 899]);
      expect(ledgerLines(dir, 'provider'), [
        '{"side":"provider","action":"read","file":"consumer/create-order.request.json"}',
        '{"side":"provider","action":"read","file":"tables/order-total.json"}',
      ]);
    });

    test('does not record a read that failed', () {
      final dir = copyOfContracts();
      writeFile(dir, 'provider/broken.json', '{"format":2}');
      final consumer = ContractFixtures(side: ContractSide.consumer, dir: dir);
      expect(
        () => consumer.readResponse('no-such-fixture'),
        throwsA(isA<ContractFixtureException>()),
      );
      expect(
        () => consumer.readResponse('broken'),
        throwsA(
          isA<ContractFixtureException>().having(
            (e) => e.toString(),
            'message',
            contains('does not follow the format'),
          ),
        ),
      );
      expect(ledgerLines(dir, 'consumer'), isEmpty);
    });

    test('reading never writes, also in update mode', () {
      final dir = copyOfContracts();
      final consumer = ContractFixtures(
        side: ContractSide.consumer,
        dir: dir,
        update: true,
      );
      expect(
        () => consumer.readResponse('no-such-fixture'),
        throwsA(isA<ContractFixtureException>()),
      );
      expect(File('$dir/provider/no-such-fixture.json').existsSync(), isFalse);
    });

    test('lists fixture names, sorted, optionally by prefix', () {
      final dir = copyOfContracts();
      writeFile(dir, 'provider/README.md', 'notes');
      final contract = ContractFixtures(side: ContractSide.consumer, dir: dir);
      expect(contract.list(FixtureKind.provider), [
        'order.created',
        'order.out-of-stock',
      ]);
      expect(contract.list(FixtureKind.provider, prefix: 'order.c'), [
        'order.created',
      ]);
      expect(contract.list(FixtureKind.tables), ['order-total']);
      expect(
        ContractFixtures(side: ContractSide.consumer, dir: tempDir())
            .list(FixtureKind.consumer),
        isEmpty,
      );
    });

    test('assertCovers passes when the expectations name exactly the fixtures',
        () {
      final contract = ContractFixtures(
        side: ContractSide.consumer,
        dir: copyOfContracts(),
      );
      contract.assertCovers(FixtureKind.provider, [
        'order.out-of-stock',
        'order.created',
      ]);
      contract.assertCovers(
        FixtureKind.provider,
        {'order.created'},
        prefix: 'order.c',
      );
    });

    test(
        'assertCovers fails for a fixture without an expectation and the reverse',
        () {
      final contract = ContractFixtures(
        side: ContractSide.consumer,
        dir: copyOfContracts(),
      );
      expect(
        () => contract.assertCovers(FixtureKind.provider, [
          'order.created',
          'order.refunded',
        ]),
        throwsA(
          isA<ContractCoverageException>()
              .having((e) => e.withoutExpectation, 'withoutExpectation', [
            'order.out-of-stock',
          ]).having((e) => e.withoutFixture, 'withoutFixture', [
            'order.refunded',
          ]).having(
            (e) => e.message,
            'message',
            allOf(
              contains(
                'provider/order.out-of-stock.json: no expectation',
              ),
              contains('order.refunded: expected here'),
            ),
          ),
        ),
      );
    });

    test('an integer-valued double equals the stored integer', () {
      final dir = copyOfContracts();
      ContractFixtures(side: ContractSide.provider, dir: dir).verifyResponse(
        name: 'order.out-of-stock',
        description: 'The item is out of stock',
        request: const ExchangeRequest(
          method: 'POST',
          path: '/orders',
          headers: {'authorization': '<token:customer-1>'},
          body: {'sku': 'mug-200', 'quantity': 1.0},
        ),
        response: const ExchangeResponse(
          status: 409,
          body: {'error': 'out_of_stock'},
        ),
      );
      expect(ledgerLines(dir, 'provider'), hasLength(1));
    });

    test('update mode writes integer-valued doubles without a fraction', () {
      final dir = tempDir();
      ContractFixtures(
        side: ContractSide.consumer,
        dir: dir,
        update: true,
      ).verifyRequest(
        name: 'pay.request',
        description: 'A payment',
        request: const ExchangeRequest(
          method: 'POST',
          path: '/payments',
          body: {'amount': 12.0, 'rate': 0.5},
        ),
      );
      expect(
        File('$dir/consumer/pay.request.json').readAsStringSync(),
        contains('"amount": 12,\n      "rate": 0.5'),
      );
    });

    test('resetLedger forgets one side only', () {
      final dir = copyOfContracts();
      ContractFixtures(side: ContractSide.provider, dir: dir)
          .readTable('order-total');
      ContractFixtures(side: ContractSide.consumer, dir: dir)
          .readTable('order-total');
      resetLedger(dir: dir, side: ContractSide.provider);
      expect(ledgerLines(dir, 'provider'), isEmpty);
      expect(ledgerLines(dir, 'consumer'), hasLength(1));
      resetLedger(dir: dir, side: ContractSide.provider);
    });
  });

  group('resolvePlaceholders', () {
    test('replaces placeholders anywhere in a JSON value, leaving the input',
        () {
      final headers = {
        'authorization': '<token:customer-1>',
        'accept': 'application/json',
      };
      final resolved = resolvePlaceholders<Map<String, dynamic>>(
        {
          'headers': headers,
          'list': ['<token:customer-1>', 1, null],
        },
        (kind, name) => kind == 'token' ? 'Bearer real-$name' : null,
      );
      expect(resolved, {
        'headers': {
          'authorization': 'Bearer real-customer-1',
          'accept': 'application/json',
        },
        'list': ['Bearer real-customer-1', 1, null],
      });
      expect(headers['authorization'], '<token:customer-1>');
    });

    test('keeps the type of a map of strings', () {
      final Map<String, String> resolved = resolvePlaceholders(
        const {'authorization': '<token:a>'},
        (kind, name) => 'real',
      );
      expect(resolved, {'authorization': 'real'});
    });

    test('fails for a placeholder without a value', () {
      expect(
        () => resolvePlaceholders({'a': '<key:unknown>'}, (kind, name) => null),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('no value for the placeholder <key:unknown>'),
          ),
        ),
      );
    });
  });
}
