import 'dart:convert';
import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:contract_fixtures/src/pattern.dart';
import 'package:contract_fixtures/src/secrets.dart';
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
    test('needs a directory at the first use, not when it is created', () {
      // A tool that only loads the test file gets this far without a directory.
      final environment = <String, String>{};
      final contract = ContractFixtures(
        side: ContractSide.provider,
        environment: environment,
      );
      expect(contract.side, ContractSide.provider);
      final missing = throwsA(
        isA<ContractUsageException>().having(
          (e) => e.message,
          'message',
          contains(
            'pass the contracts directory as `dir` or set CONTRACT_FIXTURES_DIR',
          ),
        ),
      );
      for (final use in <void Function()>[
        () => contract.dir,
        () => contract.list(FixtureKind.provider),
        () => contract.assertCovers(FixtureKind.provider, const []),
        () => contract.assertPrefixesCover(FixtureKind.provider, const []),
        () => contract.readTable('order-total'),
        () => contract.readRequest('create-order.request'),
        () => contract.verifyResponse(
              name: 'order.out-of-stock',
              description: 'The item is out of stock',
              request: _request,
              response: const ExchangeResponse(status: 409),
            ),
      ]) {
        expect(use, missing);
      }
      // The environment is read at that first use, and the answer is kept.
      final dir = copyOfContracts();
      environment['CONTRACT_FIXTURES_DIR'] = dir;
      expect(contract.dir, Directory(dir).absolute.path);
      environment.remove('CONTRACT_FIXTURES_DIR');
      expect(contract.list(FixtureKind.tables), ['order-total']);
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

    test('refuses update mode from the environment in CI', () {
      final dir = tempDir();
      final environment = {
        'CONTRACT_FIXTURES_DIR': dir,
        'CONTRACT_FIXTURES_UPDATE': '1',
        'CI': 'true',
      };
      expect(
        () => ContractFixtures(
          side: ContractSide.provider,
          environment: environment,
        ),
        throwsA(
          isA<ContractUsageException>().having(
            (e) => e.message,
            'message',
            contains('is set in CI'),
          ),
        ),
      );
      expect(
        ContractFixtures(
          side: ContractSide.provider,
          update: true,
          environment: environment,
        ).update,
        isTrue,
      );
    });

    test('refuses NaN and Infinity', () {
      final dir = tempDir();
      final provider = ContractFixtures(
        side: ContractSide.provider,
        dir: dir,
        update: true,
      );
      for (final bad in [
        double.nan,
        double.infinity,
        double.negativeInfinity
      ]) {
        expect(
          () => provider.verifyResponse(
            name: 'order.out-of-stock',
            description: 'The item is out of stock',
            request: _request,
            response: ExchangeResponse(status: 200, body: {'total': bad}),
          ),
          throwsA(
            isA<ContractFixtureException>().having(
              (e) => e.message,
              'message',
              contains('what this side produced is not a valid fixture'),
            ),
          ),
        );
      }
      expect(Directory('$dir/provider').existsSync(), isFalse);
      expect(ledgerLines(dir, 'provider'), isEmpty);
    });

    test('reports a file that is not UTF-8 as an invalid fixture', () {
      final dir = copyOfContracts();
      File('$dir/provider/order.created.json').writeAsBytesSync([
        ...'{"description":"'.codeUnits,
        0xff,
        ...'"}'.codeUnits,
      ]);
      File('$dir/.ledger/consumer.jsonl')
        ..parent.createSync(recursive: true)
        ..writeAsBytesSync([0xff, 0x0a]);
      final consumer = ContractFixtures(side: ContractSide.consumer, dir: dir);
      expect(
        () => consumer.readResponse('order.created'),
        throwsA(
          isA<ContractFixtureException>().having(
            (e) => e.message,
            'message',
            contains('is not valid UTF-8'),
          ),
        ),
      );
      final problems =
          checkContracts(dir: dir, side: ContractSide.consumer).problems;
      expect(
        [
          for (final p in problems)
            if (p.code == 'invalid') [p.file, p.message],
        ],
        [
          [
            'provider/order.created.json',
            'invalid fixture: (root) is not valid UTF-8',
          ],
        ],
      );
      expect(problems.where((p) => p.code == 'ledger'), hasLength(1));
    });

    test('follows a symbolic link to a fixture and ignores a dangling one', () {
      final dir = copyOfContracts();
      Link('$dir/provider/linked.json')
          .createSync('$dir/provider/order.created.json');
      Link('$dir/provider/dangling.json').createSync('$dir/nowhere.json');
      final consumer = ContractFixtures(side: ContractSide.consumer, dir: dir);
      expect(consumer.list(FixtureKind.provider), [
        'linked',
        'order.created',
        'order.out-of-stock',
      ]);
      final result = checkContracts(dir: dir, side: ContractSide.consumer);
      expect(result.fixtures, 5);
      expect(
        result.problems.any(
          (p) => p.file == 'provider/linked.json' && p.code == 'invalid',
        ),
        isTrue,
      );
    }, testOn: '!windows');

    test('differences accepts maps of any static type', () {
      expect(
        differences(<dynamic, dynamic>{'a': 1}, <Object, Object>{'a': 1}),
        isEmpty,
      );
      expect(
        differences(<dynamic, dynamic>{'a': 1}, <dynamic, dynamic>{'a': 2})
            .map((d) => d.text),
        ['a: 1 -> 2'],
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

    test('does not read outside the contracts directory', () {
      final consumer = ContractFixtures(
        side: ContractSide.consumer,
        dir: copyOfContracts(),
      );
      expect(
        () => consumer.readResponse('../consumer/create-order.request'),
        throwsA(isA<ContractUsageException>()),
      );
      expect(
        () => consumer.readTable(''),
        throwsA(isA<ContractUsageException>()),
      );
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

    test('a ledger that cannot be written fails the verify and the read', () {
      final dir = copyOfContracts();
      Directory('$dir/.ledger/provider.jsonl').createSync(recursive: true);
      final contract = ContractFixtures(side: ContractSide.provider, dir: dir);
      final unusable = throwsA(
        isA<ContractUsageException>().having(
          (e) => e.message,
          'message',
          'contract_fixtures: the ledger .ledger/provider.jsonl cannot be used '
              '(it is not a file, or it cannot be read or written)',
        ),
      );
      expect(() => contract.readTable('order-total'), unusable);
      expect(
        () => contract.verifyResponse(
          name: 'order.out-of-stock',
          description: 'The item is out of stock',
          request: _request,
          response: const ExchangeResponse(
            status: 409,
            body: {'error': 'out_of_stock'},
          ),
        ),
        unusable,
      );
      expect(
        () => resetLedger(dir: dir, side: ContractSide.provider),
        unusable,
      );
      expect(
        () => checkContracts(dir: dir, side: ContractSide.provider),
        unusable,
      );
      // The other side is not affected.
      ContractFixtures(side: ContractSide.consumer, dir: dir)
          .readTable('order-total');
      expect(ledgerLines(dir, 'consumer'), hasLength(1));
    });

    test(
        'a file in the place of the ledger directory: nothing to reset or to check, and no place to write',
        () {
      final dir = copyOfContracts();
      File('$dir/.ledger').writeAsStringSync('');
      resetLedger(dir: dir, side: ContractSide.provider);
      expect(
        checkContracts(dir: dir, side: ContractSide.provider).untouched,
        isTrue,
      );
      expect(
        () => ContractFixtures(side: ContractSide.provider, dir: dir)
            .readTable('order-total'),
        throwsA(
          isA<ContractUsageException>().having(
            (e) => e.message,
            'message',
            contains('the ledger .ledger/provider.jsonl cannot be used'),
          ),
        ),
      );
    });

    test('the configuration of the directory is read for every verify and read',
        () {
      final dir = copyOfContracts();
      final consumer = ContractFixtures(side: ContractSide.consumer, dir: dir);
      expect(consumer.readResponse('order.created').response.status, 201);
      // What it forbids is refused on the reading side too.
      writeFile(dir, 'config.json', '{ "format": 1, "forbidden": ["^ord_"] }');
      expect(
        () => consumer.readResponse('order.created'),
        throwsA(
          isA<ContractFixtureException>()
              .having((e) => e.file, 'file', 'provider/order.created.json')
              .having(
                (e) => e.issues.map((issue) => issue.code),
                'codes',
                everyElement('forbidden'),
              )
              .having((e) => e.message, 'message', isNot(contains('ord_81f3'))),
        ),
      );
      // A configuration that is not valid stops reading and verifying, and nothing is
      // recorded.
      writeFile(dir, 'config.json', '{');
      final invalid = throwsA(
        isA<ContractFixtureException>()
            .having((e) => e.file, 'file', 'config.json')
            .having(
              (e) => e.message,
              'message',
              'config.json of the contracts directory does not follow the format:\n'
                  '  (root): is not valid JSON',
            ),
      );
      expect(() => consumer.readTable('order-total'), invalid);
      expect(
        () => ContractFixtures(side: ContractSide.provider, dir: dir)
            .verifyResponse(
          name: 'order.out-of-stock',
          description: 'The item is out of stock',
          request: _request,
          response: const ExchangeResponse(
            status: 409,
            body: {'error': 'out_of_stock'},
          ),
        ),
        invalid,
      );
      expect(ledgerLines(dir, 'consumer'), hasLength(1));
      expect(ledgerLines(dir, 'provider'), isEmpty);
      // Bytes that are not UTF-8 are reported like a fixture's.
      File('$dir/config.json').writeAsBytesSync([0x7b, 0xff, 0x7d]);
      expect(
        checkContracts(dir: dir, side: ContractSide.consumer)
            .problems
            .where((p) => p.file == 'config.json')
            .map((p) => p.message),
        ['invalid configuration: (root) is not valid UTF-8'],
      );
    });

    test('a file in the place of a directory of fixtures holds no fixtures',
        () {
      final dir = tempDir();
      File('$dir/provider').writeAsStringSync('');
      expect(
        ContractFixtures(side: ContractSide.provider, dir: dir)
            .list(FixtureKind.provider),
        isEmpty,
      );
      expect(
        checkContracts(dir: dir, side: ContractSide.provider)
            .problems
            .map((p) => p.code),
        ['empty'],
      );
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

    test('keeps the type of a list of strings', () {
      final List<String> resolved = resolvePlaceholders(
        const ['<token:a>', 'plain'],
        (kind, name) => 'real',
      );
      expect(resolved, ['real', 'plain']);
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

  group('secret paths', () {
    // A string of the shape of a token; a new one on every call, as a real API would issue.
    var issued = 0;
    String part(Object value) =>
        base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
    String issueToken() => [
          part({'alg': 'HS256'}),
          part({'sub': 'customer-1', 'n': ++issued}),
          'c2lnbmF0dXJl',
        ].join('.');

    const request = ExchangeRequest(
      method: 'POST',
      path: '/sessions',
      body: {
        'email': 'customer-1@example.test',
        'password': '<password:customer-1>',
      },
    );
    const secret = {'response.body.access_token': '<token:session-1>'};
    void verifySession(
      ContractFixtures contract,
      Object? token, {
      int seconds = 3600,
      Map<String, String> secret = const {},
    }) {
      contract.verifyResponse(
        name: 'session.created',
        description: 'Signing in returns an access token',
        request: request,
        response: ExchangeResponse(
          status: 200,
          body: {'access_token': token, 'expires_in': seconds},
        ),
        secret: secret,
      );
    }

    ContractFixtures provider(String dir, {required bool update}) =>
        ContractFixtures(side: ContractSide.provider, dir: dir, update: update);
    String everythingIn(String dir) =>
        everyFileIn(dir).map((file) => file.readAsStringSync()).join('\n');
    T thrownBy<T>(void Function() run) {
      try {
        run();
      } on Object catch (error) {
        return error as T;
      }
      fail('nothing was thrown');
    }

    test('negative control: without a secret path, a token cannot be written',
        () {
      final dir = tempDir();
      final token = issueToken();

      final error = thrownBy<ContractFixtureException>(
        () => verifySession(provider(dir, update: true), token),
      );

      expect(
        [for (final issue in error.issues) '${issue.code} ${issue.path}'],
        ['jwt response.body.access_token'],
      );
      expect('$error', isNot(contains(token)));
      expect(everyFileIn(dir), isEmpty);
    });

    test(
        'with a secret path, the real value is nowhere: not in a file, the '
        'ledger or a message', () {
      final dir = tempDir();
      final first = issueToken();
      verifySession(provider(dir, update: true), first, secret: secret);

      // Another run issues another token; the stored placeholder still matches.
      final second = issueToken();
      verifySession(provider(dir, update: false), second, secret: secret);

      // A difference elsewhere is reported without the token.
      final third = issueToken();
      final error = thrownBy<ContractMismatch>(
        () => verifySession(
          provider(dir, update: false),
          third,
          seconds: 60,
          secret: secret,
        ),
      );
      expect(
        [for (final d in error.differences) d.text],
        ['response.body.expires_in: 3600 -> 60'],
      );

      final written = '${everythingIn(dir)}$error';
      expect(written, contains('"access_token": "<token:session-1>"'));
      expect(ledgerLines(dir, 'provider'), hasLength(2));
      for (final token in [first, second, third]) {
        expect(written, isNot(contains(token)));
      }
      expect(jwtPattern.hasMatch(written), isFalse);
    });

    test(
        'a test that stops passing the secret path does not print the value '
        'either', () {
      final dir = tempDir();
      verifySession(provider(dir, update: true), 'opaque-value-1',
          secret: secret);

      final error = thrownBy<ContractMismatch>(
        () => verifySession(provider(dir, update: false), 'opaque-value-2'),
      );

      expect([for (final d in error.differences) d.path], ['secret']);
      expect('$error', isNot(contains('opaque-value-2')));
    });

    test(
        'a value that is not a string, or a path that matches nothing, is an '
        'error without the value', () {
      final dir = tempDir();

      final notString = thrownBy<ContractFixtureException>(
        () => verifySession(
          provider(dir, update: true),
          {'value': 'opaque-value-3'},
          secret: secret,
        ),
      );
      expect(
        [for (final issue in notString.issues) '${issue.code} ${issue.path}'],
        ['secret-value response.body.access_token'],
      );
      expect('$notString', isNot(contains('opaque-value-3')));

      final unmatched = thrownBy<ContractFixtureException>(
        () => verifySession(
          provider(dir, update: true),
          'opaque-value-4',
          secret: const {'response.body.refresh_token': '<token:renewal-1>'},
        ),
      );
      expect(
        [for (final issue in unmatched.issues) '${issue.code} ${issue.path}'],
        ['secret-unmatched secret.response.body.refresh_token'],
      );
      expect(everyFileIn(dir), isEmpty);
    });

    test(
        'update mode does not drop a secret path, and says which one without '
        'the value', () {
      final dir = tempDir();
      verifySession(provider(dir, update: true), 'opaque-value-5',
          secret: secret);
      final before = everythingIn(dir);

      final error = thrownBy<ContractFixtureException>(
        () => verifySession(provider(dir, update: true), 'opaque-value-6'),
      );

      expect(
        error.message,
        'contract fixture provider/session.created.json is not updated, because that would drop a secret path:\n'
        '  secret.response.body.access_token: is a secret path of the stored fixture, but this test does not pass it\n'
        'Pass the path as `secret` in this test, or remove it from the stored file by hand.',
      );
      expect(everythingIn(dir), before);
      expect(before, isNot(contains('opaque-value')));
    });

    test(
        'a number that is not JSON is reported before a header that is given '
        'twice', () {
      final consumer = ContractFixtures(
        side: ContractSide.consumer,
        dir: tempDir(),
        update: true,
      );
      void verify(Object body) => consumer.verifyRequest(
            name: 'create-order.request',
            description: 'The request the client sends to place an order',
            request: ExchangeRequest(
              method: 'POST',
              path: '/orders',
              headers: const {'Accept': 'a', 'accept': 'b'},
              body: body,
            ),
          );

      expect(
        () => verify({'n': double.nan}),
        throwsA(isA<ContractFixtureException>()),
      );
      expect(() => verify({'n': 1}), throwsA(isA<ContractUsageException>()));
    });

    test('does not change what the test passed in', () {
      final token = issueToken();
      final body = {'access_token': token, 'expires_in': 3600};

      provider(tempDir(), update: true).verifyResponse(
        name: 'session.created',
        description: 'Signing in returns an access token',
        request: request,
        response: ExchangeResponse(status: 200, body: body),
        secret: secret,
      );

      expect(body['access_token'], token);
    });

    test('the reading side gets the placeholder and puts a value of its own in',
        () {
      final dir = tempDir();
      verifySession(provider(dir, update: true), issueToken(), secret: secret);

      final fixture = ContractFixtures(side: ContractSide.consumer, dir: dir)
          .readResponse('session.created');

      expect(fixture.secret, secret);
      expect(
        resolvePlaceholders(
          fixture.response.body,
          (kind, name) => '$kind of $name',
        ),
        {'access_token': 'token of session-1', 'expires_in': 3600},
      );
      expect(
        checkContracts(dir: dir, side: ContractSide.consumer).problems,
        isEmpty,
      );
    });

    test('uses the expression that spec/format.md gives for a token', () {
      final format = File('../../spec/format.md').readAsStringSync();
      expect(format, contains('\n```\n${jwtPattern.pattern}\n```\n'));
    });
  });

  group('response headers', () {
    void signIn(ContractFixtures contract, Map<String, dynamic> headers) {
      contract.verifyResponse(
        name: 'session.created',
        description: 'Signing in sets the session cookies',
        request: const ExchangeRequest(
          method: 'POST',
          path: '/sessions',
          headers: {
            'Accept': ['application/json', 'text/plain'],
          },
        ),
        response: ExchangeResponse(status: 204, headers: headers),
        secret: const {'response.headers.set-cookie.0': '<cookie:session-1>'},
      );
    }

    ContractFixtures provider(String dir, {required bool update}) =>
        ContractFixtures(side: ContractSide.provider, dir: dir, update: update);

    test('records them with lower-case names, and the reading side gets them',
        () {
      final dir = tempDir();
      signIn(provider(dir, update: true), {
        'Set-Cookie': ['session=opaque-1; HttpOnly', 'theme=dark'],
        'Cache-Control': 'no-store',
      });

      final fixture = ContractFixtures(side: ContractSide.consumer, dir: dir)
          .readResponse('session.created');

      expect(fixture.request.headerValues('accept'),
          ['application/json', 'text/plain']);
      expect(fixture.response.headers, {
        'set-cookie': ['<cookie:session-1>', 'theme=dark'],
        'cache-control': 'no-store',
      });
      expect(fixture.response.headerValues('set-cookie'),
          ['<cookie:session-1>', 'theme=dark']);
      expect(fixture.response.headerValues('cache-control'), ['no-store']);
      expect(fixture.response.headerValues('etag'), isEmpty);
      expect(fixture.response.body, isNull);
      for (final file in everyFileIn(dir)) {
        expect(file.readAsStringSync(), isNot(contains('opaque-1')));
      }
    });

    test('takes the header map of an HTTP library as it is', () {
      final dir = tempDir();
      // One value per name, a list per name, and a decoded JSON map.
      const single = <String, String>{'set-cookie': 'session=opaque-2'};
      const lists = <String, List<String>>{
        'set-cookie': ['session=opaque-2'],
      };
      final decoded = <String, dynamic>{
        'set-cookie': <dynamic>['session=opaque-2'],
      };

      signIn(provider(dir, update: true), lists);
      signIn(provider(dir, update: false), decoded);
      // A single string is another shape: the path of the secret, which names the first
      // element of a list, matches nothing in it.
      expect(
        () => signIn(provider(dir, update: false), single),
        throwsA(isA<ContractFixtureException>()),
      );
    });

    test('refuses a header value that is neither a string nor a list of them',
        () {
      final update = provider(tempDir(), update: true);

      for (final value in <Object?>[1, null, <String>[], true]) {
        expect(
          () => signIn(update, {'set-cookie': 'a=1', 'retry-after': value}),
          throwsA(
            isA<ContractFixtureException>().having(
              (e) => [for (final issue in e.issues) issue.path],
              'issues',
              contains('response.headers.retry-after'),
            ),
          ),
        );
      }
    });
  });

  group('volatile entries with a pattern', () {
    const volatile = <Object>[
      VolatilePattern('response.body.id', r'^ord_[a-z0-9]+$'),
      'response.body.**.created_at',
    ];
    void created(
      ContractFixtures contract,
      Object? id, {
      List<Object> volatile = volatile,
    }) {
      contract.verifyResponse(
        name: 'order.created',
        description: 'An order is accepted',
        request: const ExchangeRequest(
          method: 'POST',
          path: '/orders',
          body: {'sku': 'tea-100', 'quantity': 2},
        ),
        response: ExchangeResponse(
          status: 201,
          body: {
            'id': id,
            'lines': [
              {'created_at': '2026-01-15T09:30:00Z'},
            ],
          },
        ),
        volatile: volatile,
      );
    }

    ContractFixtures provider(String dir, {required bool update}) =>
        ContractFixtures(side: ContractSide.provider, dir: dir, update: update);

    test('are stored as given and come back to the reading side', () {
      final dir = tempDir();
      created(provider(dir, update: true), 'ord_81f3');

      final fixture = ContractFixtures(side: ContractSide.consumer, dir: dir)
          .readResponse('order.created');

      expect(fixture.volatile, [
        {'path': 'response.body.id', 'pattern': r'^ord_[a-z0-9]+$'},
        'response.body.**.created_at',
      ]);
    });

    test('may be given as a map, in any key order', () {
      final dir = tempDir();
      created(provider(dir, update: true), 'ord_81f3');

      created(provider(dir, update: false), 'ord_zz9', volatile: const [
        {'pattern': r'^ord_[a-z0-9]+$', 'path': 'response.body.id'},
        'response.body.**.created_at',
      ]);
    });

    test('let the value change, but not its shape', () {
      final dir = tempDir();
      created(provider(dir, update: true), 'ord_81f3');

      created(provider(dir, update: false), 'ord_zz9');
      expect(
        () => created(provider(dir, update: false), 'zz9'),
        throwsA(isA<ContractMismatch>()),
      );
      expect(
        () => created(provider(dir, update: false), 9),
        throwsA(isA<ContractMismatch>()),
      );
    });

    test('are never written with a value that does not match', () {
      final dir = tempDir();

      expect(
        () => created(provider(dir, update: true), 'zz9'),
        throwsA(isA<ContractFixtureException>()),
      );
      expect(everyFileIn(dir), isEmpty);
    });

    test('the comparison takes them too, and refuses an entry that is not one',
        () {
      const entry = VolatilePattern('id', r'^ord_[a-z0-9]+$');
      expect(differences({'id': 'ord_1'}, {'id': 'ord_2'}, [entry]), isEmpty);
      expect(differences({'id': 'ord_1'}, {'id': '2'}, [entry]), hasLength(1));
      expect(
        () => differences({}, {}, [
          {'path': 'a'},
        ]),
        throwsArgumentError,
      );
      expect(
        () => differences({}, {}, [const VolatilePattern('a', '(')]),
        throwsA(isA<PatternException>()),
      );
    });

    test(
        'a pattern that would stall a backtracking engine is answered at '
        'once', () {
      final pattern = compilePattern('(a+)+b|(a|aa)*c|(a?){200}a{200}');
      final long = 'a' * 20000;

      expect(pattern.test(long), isFalse);
      expect(pattern.test('${long}b'), isTrue);
      expect(pattern.test('${long}c'), isTrue);
      expect(pattern.test('a' * 300), isTrue);
    });
  });
}
