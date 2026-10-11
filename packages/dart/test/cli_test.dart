import 'dart:convert';
import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:contract_fixtures/src/version.dart';
import 'package:test/test.dart';

import 'helpers.dart';

({int code, String out, String err}) run(
  List<String> arguments, [
  Map<String, String> environment = const {},
]) {
  final out = <String>[];
  final err = <String>[];
  final code = runCli(
    arguments,
    out: out.add,
    err: err.add,
    environment: environment,
  );
  return (code: code, out: out.join('\n'), err: err.join('\n'));
}

void exerciseProviderSide(String dir) {
  final provider = ContractFixtures(
    side: ContractSide.provider,
    dir: dir,
    update: true,
  );
  for (final name in ['order.created', 'order.out-of-stock']) {
    final stored = ProviderFixture(
      jsonDecode(File('$dir/provider/$name.json').readAsStringSync())
          as Map<String, dynamic>,
    );
    provider.verifyResponse(
      name: stored.name,
      description: stored.description,
      request: stored.request,
      response: stored.response,
      volatile: stored.volatile,
    );
  }
  provider.readRequest('create-order.request');
  provider.readTable('order-total');
}

void main() {
  test('check exits 0 when this side did everything', () {
    final dir = copyOfContracts();
    exerciseProviderSide(dir);
    final result = run(['check', '--side', 'provider', '--dir', dir]);
    expect(result.code, 0);
    expect(
      result.out,
      'contract_fixtures check (provider side): OK (4 fixture(s), '
      "all verified or read by this side's tests)",
    );
    expect(result.err, isEmpty);
  });

  test('check exits 1 and names every fixture this side did not touch', () {
    final dir = copyOfContracts();
    exerciseProviderSide(dir);
    File('$dir/tables/rates.json').writeAsStringSync(
      File('$dir/tables/order-total.json')
          .readAsStringSync()
          .replaceFirst('"order-total"', '"rates"'),
    );
    ContractFixtures(side: ContractSide.consumer, dir: dir).readTable('rates');
    final result = run(['check', '--side=consumer', '--dir=$dir']);
    expect(result.code, 1);
    expect(result.out, isEmpty);
    expect(result.err.split('\n'), [
      'contract_fixtures check (consumer side): 4 problem(s) in 5 fixture(s)',
      "  - provider/order.created.json: not read by the consumer side's tests (add a test that feeds it to the real code)",
      "  - provider/order.out-of-stock.json: not read by the consumer side's tests (add a test that feeds it to the real code)",
      "  - consumer/create-order.request.json: not verified by the consumer side's tests (stale: delete it, or restore the test that produces it)",
      "  - tables/order-total.json: not read by the consumer side's tests (add a test that feeds it to the real code)",
      'Hint: Only 1 of the 5 fixtures that follow the format were verified or read. If a part of the tests ran (a filter, one shard of several), run all of them, or join the ledgers of all shards, before this check.',
      "Run `contract_fixtures reset` and the consumer side's tests before this check.",
    ]);
  });

  test(
      'check does not list the fixtures one by one when the ledger has no entries',
      () {
    final dir = copyOfContracts();
    exerciseProviderSide(dir);
    final result = run(['check', '--side=consumer', '--dir=$dir']);
    expect(result.code, 1);
    expect(result.err.split('\n'), [
      'contract_fixtures check (consumer side): 4 problem(s) in 4 fixture(s)',
      "  - none of the 4 fixture(s) that follow the format was verified or read by the consumer side's tests (they are not listed one by one)",
      "Hint: .ledger/consumer.jsonl does not exist, but .ledger/provider.jsonl has some. Did the consumer side's tests run, and is consumer the side to check?",
      "Run `contract_fixtures reset` and the consumer side's tests before this check.",
    ]);
  });

  test('a command that cannot finish exits with 1 and says so in one line', () {
    final dir = copyOfContracts();
    Process.runSync('chmod', ['000', '$dir/provider/order.created.json']);
    for (final (command, arguments) in [
      ('check', ['check', '--side', 'provider', '--dir', dir]),
      ('summary', ['summary', '--dir', dir]),
    ]) {
      final result = run(arguments);
      expect(result.code, 1, reason: command);
      expect(result.out, isEmpty);
      final lines = result.err.split('\n');
      expect(lines.first, 'contract_fixtures: $command could not finish');
      expect(lines.length, greaterThan(1),
          reason: 'the second line has the error of the file system');
    }
  },
      // Needs a file that cannot be read.
      skip: Platform.isWindows ||
          Process.runSync('id', ['-u']).stdout.toString().trim() == '0');

  test('check exits 1 for an empty directory', () {
    final result = run(['check', '--side', 'provider', '--dir', tempDir()]);
    expect(result.code, 1);
    expect(result.err, contains('no fixtures found'));
  });

  test("reset forgets this side's ledger, so the next check fails", () {
    final dir = copyOfContracts();
    exerciseProviderSide(dir);
    final reset = run(['reset', '--side', 'provider', '--dir', dir]);
    expect(reset.code, 0);
    expect(
      reset.out,
      'contract_fixtures reset (provider side): '
      'OK (no entries in .ledger/provider.jsonl)',
    );
    expect(ledgerLines(dir, 'provider'), isEmpty);
    expect(run(['check', '--side', 'provider', '--dir', dir]).code, 1);
  });

  test(
      'check prints no hint when it passes, and none for problems the ledger does not explain',
      () {
    final dir = copyOfContracts();
    exerciseProviderSide(dir);
    expect(
      run(['check', '--side', 'provider', '--dir', dir]).out,
      isNot(contains('Hint')),
    );
    File('$dir/provider/order.created.json').writeAsStringSync('{');
    final result = run(['check', '--side', 'provider', '--dir', dir]);
    expect(result.code, 1);
    expect(result.err, isNot(contains('Hint')));
  });

  test('summary prints one line per fixture and leaves the ledger alone', () {
    final dir = copyOfContracts();
    final result = run(['summary', '--dir', dir]);
    expect(result.code, 0);
    expect(result.err, isEmpty);
    expect(result.out.split('\n'), [
      'FIXTURE                        REQUEST       STATUS  RESPONSE BODY',
      'provider/order.created         POST /orders  201     {created_at: string, id: string, lines: array, status: string, total_minor: number}',
      'provider/order.out-of-stock    POST /orders  409     {error: string}',
      'consumer/create-order.request  POST /orders  -       -',
      'tables/order-total             -             -       2 row(s)',
    ]);
    expect(Directory('$dir/.ledger').existsSync(), isFalse);
    expect(run(['summary'], {'CONTRACT_FIXTURES_DIR': dir}).out, result.out);
  });

  test('summary exits 1 for a directory without fixtures', () {
    final result = run(['summary', '--dir', tempDir()]);
    expect(result.code, 1);
    expect(result.out, isEmpty);
    expect(result.err, contains('no fixtures found'));
  });

  test('takes the directory from the environment', () {
    final dir = copyOfContracts();
    exerciseProviderSide(dir);
    expect(
      run(['check', '--side', 'provider'], {'CONTRACT_FIXTURES_DIR': dir}).code,
      0,
    );
  });

  test('exits 2 for wrong usage', () {
    final dir = copyOfContracts();
    final wrong = [
      <String>[],
      ['verify', '--side', 'provider', '--dir', dir],
      ['check', '--dir', dir],
      ['check', '--side', 'client', '--dir', dir],
      ['check', '--side', 'provider'],
      ['check', '--side', 'provider', '--dir', '$dir/no-such-directory'],
      [
        'check',
        '--side',
        'provider',
        '--dir',
        '$dir/provider/order.created.json'
      ],
      ['check', '--side', 'provider', '--dir', dir, '--strict'],
      ['check', 'extra', '--side', 'provider', '--dir', dir],
      ['check', '--side'],
      ['summary', '--side', 'provider', '--dir', dir],
      ['summary'],
      ['summary', '--dir', dir, '--depth', '0'],
      ['check', '--side', 'provider', '--dir', dir, '--depth', '2'],
      ['list', '--dir', dir],
    ];
    for (final arguments in wrong) {
      final result = run(arguments);
      expect(result.code, 2, reason: arguments.join(' '));
      expect(
        result.err,
        matches(
          RegExp(
              r'^contract_fixtures: .+\n\ncontract_fixtures — .+\n\nUsage: '),
        ),
        reason: arguments.join(' '),
      );
    }
  });

  test('prints the usage for --help', () {
    final result = run(['--help']);
    expect(result.code, 0);
    expect(result.out, usage);
    expect(
      result.out,
      contains('\n\nUsage: contract_fixtures <reset|check> --side'),
    );
  });

  test('prints the version of pubspec.yaml for --version', () {
    for (final flag in ['--version', '-v']) {
      final result = run([flag]);
      expect((result.code, result.out, result.err), (0, packageVersion, ''));
    }
    expect(
      File('pubspec.yaml').readAsLinesSync(),
      contains('version: $packageVersion'),
    );
  });

  test(
      'the copies of the changelog and the licence in this package are those of the repository',
      () {
    for (final file in ['CHANGELOG.md', 'LICENSE']) {
      expect(
        File(file).readAsStringSync(),
        File('../../$file').readAsStringSync(),
        reason: file,
      );
    }
  });

  test('the executable sets the exit code', () {
    final dir = copyOfContracts();
    exerciseProviderSide(dir);
    ProcessResult bin(List<String> arguments) => Process.runSync(
          Platform.resolvedExecutable,
          ['run', 'contract_fixtures', ...arguments],
        );
    final ok = bin(['check', '--side', 'provider', '--dir', dir]);
    expect(ok.exitCode, 0, reason: '${ok.stderr}');
    expect(ok.stdout, contains('4 fixture(s)'));
    expect(bin(['check', '--side', 'consumer', '--dir', dir]).exitCode, 1);
    expect(bin(['check']).exitCode, 2);
    final version = bin(['--version']);
    expect((version.exitCode, version.stdout), (0, '$packageVersion\n'));
  });
}
