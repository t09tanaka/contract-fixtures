// Runs the language independent cases in spec/fixtures. The TypeScript package runs the
// same files; that both pass is what "the two packages treat a fixture the same way" means.
import 'dart:convert';
import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:contract_fixtures/src/pattern.dart';
import 'package:contract_fixtures/src/version.dart';
import 'package:test/test.dart';

import 'helpers.dart';

/// What {tool} stands for in the shared cases: the name of this package's executable.
const tool = 'contract_fixtures';

void main() {
  group('spec/fixtures/differences.json', () {
    for (final c in loadCases('differences.json')) {
      test(c['case'], () {
        final diffs = differences(
          c['expected'],
          c['actual'],
          c['volatile'] as List<dynamic>,
        );
        expect(
          [
            for (final d in diffs)
              {'path': d.path, 'kind': d.kind.name, 'text': d.text},
          ],
          c['differences'],
        );
      });
    }
  });

  group('spec/fixtures/validation.json', () {
    for (final c in loadCases('validation.json')) {
      test(c['case'], () {
        final kind = FixtureKind.values.byName(c['kind'] as String);
        final name = c['name'] as String;
        final config = ContractsConfig(
          forbidden: (c['forbidden'] as List<dynamic>? ?? const <dynamic>[])
              .cast<String>(),
        );
        final issues = c.containsKey('text')
            ? validateFixture(kind, name, c['text'] as String, config).issues
            : validateFixtureValue(kind, name, c['value'], config);
        expect(
          [
            for (final i in issues) {'code': i.code, 'path': i.path},
          ],
          c['issues'],
        );
        expect(issues.map((i) => i.message), everyElement(isNotEmpty));
        for (final text in c['absent'] as List<dynamic>? ?? const <dynamic>[]) {
          expect(issues.map((i) => i.message),
              everyElement(isNot(contains(text))));
        }
        if (c.containsKey('messages')) {
          expect(issues.map((i) => i.message).toList(), c['messages']);
        }
        for (final text in c['shown'] as List<dynamic>? ?? const <dynamic>[]) {
          expect(issues.map((i) => i.message), anyElement(contains(text)));
        }
      });
    }
  });

  group('spec/fixtures/configuration.json', () {
    for (final c in loadCases('configuration.json')) {
      test(c['case'], () {
        final result = validateConfig(c['text'] as String);
        expect(
          [
            for (final i in result.issues) {'code': i.code, 'path': i.path},
          ],
          c['issues'],
        );
        expect(result.issues.map((i) => i.message), everyElement(isNotEmpty));
        expect(result.config.forbidden, c['forbidden']);
      });
    }
  });

  group('spec/fixtures/canonical.json', () {
    for (final c in loadCases('canonical.json')) {
      test(c['case'], () {
        final value = jsonDecode(c['input'] as String) as Object?;
        expect(canonicalJson(value), c['pretty']);
        expect(compactJson(value), c['compact']);
      });
    }
  });

  group('spec/fixtures/placeholders.json', () {
    for (final c in loadCases('placeholders.json')) {
      test(jsonEncode(c['value']), () {
        final placeholder = parsePlaceholder(c['value'] as String);
        expect(
          placeholder == null
              ? null
              : {'kind': placeholder.kind, 'name': placeholder.name},
          c['placeholder'],
        );
      });
    }
  });

  group('spec/fixtures/patterns.json and search.json', () {
    for (final c in [
      ...loadCases('patterns.json'),
      ...loadCases('search.json'),
    ]) {
      test(c['case'], () {
        final source = c['pattern'] as String;
        if (c['valid'] == false) {
          expect(
              () => compilePattern(source), throwsA(isA<PatternException>()));
          return;
        }
        List<String> strings(String key) =>
            (c[key] as List<dynamic>? ?? const <dynamic>[]).cast<String>();
        final matches = strings('matches');
        final rejects = strings('rejects');
        final pattern = compilePattern(source);
        for (final value in strings('finds')) {
          expect(pattern.search(value), isTrue,
              reason: 'search ${jsonEncode(value)}');
        }
        for (final value in strings('findsNot')) {
          expect(pattern.search(value), isFalse,
              reason: 'search ${jsonEncode(value)}');
        }
        for (final value in matches) {
          expect(pattern.test(value), isTrue, reason: jsonEncode(value));
        }
        for (final value in rejects) {
          expect(pattern.test(value), isFalse, reason: jsonEncode(value));
        }
        // The search that tries every position, without the shortcut, on every string of a
        // case that is about searching (the others have values made to be slow to search).
        final searched = c.containsKey('finds') || c.containsKey('findsNot')
            ? const ['matches', 'rejects', 'finds', 'findsNot']
            : const <String>[];
        for (final key in searched) {
          for (final value in strings(key)) {
            expect(pattern.scan(value), pattern.search(value),
                reason: 'scan ${jsonEncode(value)}');
            if (pattern.scan(value)) {
              expect(value, contains(pattern.required));
              expect(value.length >= pattern.shortest, isTrue,
                  reason: 'the length of ${jsonEncode(value)}');
              expect(
                pattern.requiredAny.isEmpty ||
                    pattern.requiredAny.any(value.contains),
                isTrue,
                reason: 'one of the texts in ${jsonEncode(value)}',
              );
            }
          }
        }
        if (c.containsKey('required')) {
          expect(pattern.required, c['required']);
        }
        if (c.containsKey('requiredAny')) {
          expect(pattern.requiredAny, c['requiredAny']);
        }
        if (c.containsKey('shortest')) {
          expect(pattern.shortest, c['shortest']);
        }
        if (c['native'] == false) return;
        final native = RegExp('^(?:$source)\$');
        for (final value in matches) {
          expect(native.hasMatch(value), isTrue,
              reason: 'RegExp: ${jsonEncode(value)}');
        }
        for (final value in rejects) {
          expect(native.hasMatch(value), isFalse,
              reason: 'RegExp: ${jsonEncode(value)}');
        }
        final anywhere = RegExp(source);
        for (final value in strings('finds')) {
          expect(anywhere.hasMatch(value), isTrue,
              reason: 'RegExp: ${jsonEncode(value)}');
        }
        for (final value in strings('findsNot')) {
          expect(anywhere.hasMatch(value), isFalse,
              reason: 'RegExp: ${jsonEncode(value)}');
        }
      });
    }
  });

  group('spec/fixtures/check.json', () {
    for (final c in loadCases('check.json')) {
      test(c['case'], () {
        final dir = c['empty'] == true ? tempDir() : copyOfContracts();
        final files = c['files'] as Map<String, dynamic>? ?? const {};
        for (final entry in files.entries) {
          writeFile(dir, entry.key, entry.value as String);
        }
        final side = ContractSide.values.byName(c['side'] as String);
        final other = side == ContractSide.provider ? 'consumer' : 'provider';
        String lines(Object? list) =>
            (list as List<dynamic>).map((l) => '$l\n').join();
        if (c['noLedger'] != true) {
          writeFile(dir, '.ledger/${side.name}.jsonl', lines(c['ledger']));
        }
        if (c.containsKey('otherLedger')) {
          writeFile(dir, '.ledger/$other.jsonl', lines(c['otherLedger']));
        }

        final result = checkContracts(dir: dir, side: side);

        expect(result.fixtures, c['fixtures']);
        expect(
          [
            for (final p in result.problems) {'file': p.file, 'code': p.code},
          ],
          c['problems'],
        );
        expect(result.hints, c['hints']);
        expect(
          formatCheckResult(result),
          (c['report'] as String).replaceAll('{tool}', tool),
        );
      });
    }
  });

  group('spec/fixtures/cli.json', () {
    final help = loadHelp().replaceAll('{tool}', tool);

    test('the help is the exported text', () {
      expect(usage, help);
    });

    for (final c in loadCases('cli.json')) {
      test(c['case'], () {
        final dir = c['empty'] == true ? tempDir() : copyOfContracts();
        final ledger = c['ledger'] as Map<String, dynamic>? ?? const {};
        for (final entry in ledger.entries) {
          writeFile(
            dir,
            '.ledger/${entry.key}.jsonl',
            (entry.value as List<dynamic>).map((l) => '$l\n').join(),
          );
        }
        final directories =
            (c['ledgerDirectory'] as List<dynamic>? ?? const <dynamic>[]);
        for (final side in directories) {
          Directory('$dir/.ledger/$side.jsonl').createSync(recursive: true);
        }
        String inDir(Object? text) => (text as String).replaceAll('{dir}', dir);
        String printed(Object? text) => inDir(text)
            .replaceAll('{help}', help)
            .replaceAll('{tool}', tool)
            .replaceAll('{version}', packageVersion);
        final env = c['env'] as Map<String, dynamic>? ?? const {};
        final out = <String>[];
        final err = <String>[];

        final code = runCli(
          (c['args'] as List<dynamic>).map(inDir).toList(),
          out: out.add,
          err: err.add,
          environment: {
            for (final entry in env.entries) entry.key: inDir(entry.value),
          },
        );

        expect(out.join('\n'), printed(c['stdout']));
        expect(err.join('\n'), printed(c['stderr']));
        expect(code, c['exit']);
        final after = c['ledgerAfter'] as Map<String, dynamic>? ?? const {};
        for (final entry in after.entries) {
          final file = File('$dir/.ledger/${entry.key}.jsonl');
          if (directories.contains(entry.key)) {
            expect(Directory(file.path).existsSync(), isTrue,
                reason: file.path);
            continue;
          }
          expect(file.existsSync(), entry.value != null, reason: file.path);
          if (entry.value != null) {
            expect(ledgerLines(dir, entry.key), entry.value);
          }
        }
      });
    }
  });

  group('spec/fixtures/summary.json', () {
    for (final c in loadCases('summary.json')) {
      test(c['case'], () {
        final dir = c['empty'] == true ? tempDir() : copyOfContracts();
        final files = c['files'] as Map<String, dynamic>? ?? const {};
        for (final entry in files.entries) {
          writeFile(dir, entry.key, entry.value as String);
        }

        final rows =
            summarizeContracts(dir: dir, depth: c['depth'] as int? ?? 1);

        expect(rows, hasLength(c['rows'] as int));
        expect(formatSummary(rows), c['text']);
        expect(Directory('$dir/.ledger').existsSync(), isFalse);
      });
    }
  });

  group('spec/fixtures/coverage.json', () {
    for (final c in loadCases('coverage.json')) {
      test(c['case'], () {
        final dir = tempDir();
        for (final name in c['names'] as List<dynamic>) {
          writeFile(dir, 'provider/$name.json', '');
        }
        final contract =
            ContractFixtures(side: ContractSide.consumer, dir: dir);
        final expected = (c['expected'] as List<dynamic>).cast<String>();

        ContractCoverageException? error;
        try {
          if (c['call'] == 'prefixes') {
            contract.assertPrefixesCover(FixtureKind.provider, expected);
          } else {
            contract.assertCovers(
              FixtureKind.provider,
              expected,
              prefix: c['prefix'] as String? ?? '',
            );
          }
        } on ContractCoverageException catch (caught) {
          error = caught;
        }

        if (c['message'] == null) {
          expect(error, isNull);
          return;
        }
        expect(error?.message, c['message']);
        expect(error?.withoutExpectation, c['withoutExpectation']);
        expect(error?.withoutFixture, c['withoutFixture']);
      });
    }
  });

  group('spec/fixtures/verify.json', () {
    for (final c in loadCases('verify.json')) {
      test(c['case'], () {
        final dir = tempDir();
        final kind = c['kind'] as String;
        final observed = c['observed'] as Map<String, dynamic>;
        final name = observed['name'] as String;
        final relative = '$kind/$name.json';
        final file = File('$dir/$relative');
        final storedText = c['storedText'] as String?;
        if (storedText != null) writeFile(dir, relative, storedText);
        if (c.containsKey('config')) {
          writeFile(dir, 'config.json', c['config'] as String);
        }
        final warnings = <String>[];
        final contract = ContractFixtures(
          side: ContractSide.values.byName(kind),
          dir: dir,
          update: c['update'] as bool,
          warn: warnings.add,
        );
        final request = ExchangeRequest.fromJson(
          observed['request'] as Map<String, dynamic>,
        );
        final volatile =
            (observed['volatile'] as List<dynamic>? ?? const <dynamic>[])
                .cast<Object>();
        final secret = (observed['secret'] as Map<String, dynamic>? ??
                const <String, dynamic>{})
            .cast<String, Object>();

        var outcome = 'ok';
        var message = '';
        List<Map<String, String>>? issues;
        List<String>? lines;
        try {
          if (kind == 'provider') {
            contract.verifyResponse(
              name: name,
              description: observed['description'] as String,
              request: request,
              response: ExchangeResponse.fromJson(
                observed['response'] as Map<String, dynamic>,
              ),
              volatile: volatile,
              secret: secret,
            );
          } else {
            contract.verifyRequest(
              name: name,
              description: observed['description'] as String,
              request: request,
              volatile: volatile,
              secret: secret,
            );
          }
        } on ContractMismatch catch (error) {
          message = '$error';
          outcome = 'mismatch';
          lines = [for (final d in error.differences) d.text];
          for (final line in lines) {
            expect(error.message, contains(line));
          }
        } on ContractUsageException catch (error) {
          message = '$error';
          outcome = 'usage';
        } on ContractFixtureException catch (error) {
          message = '$error';
          issues = [
            for (final i in error.issues) {'code': i.code, 'path': i.path},
          ];
          outcome = error.file == 'config.json'
              ? 'invalid-config'
              : error.issues.any((i) => i.code == 'secret-removed')
                  ? 'refused'
                  : storedText == null &&
                          c['update'] == false &&
                          error.issues.isEmpty
                      ? 'missing'
                      : error.message.contains('what this side produced')
                          ? 'invalid-observed'
                          : 'invalid-stored';
        }
        final after = file.existsSync() ? file.readAsStringSync() : null;
        if (outcome == 'ok' && after != storedText) outcome = 'written';

        expect(outcome, c['outcome']);
        if (c.containsKey('differences')) expect(lines, c['differences']);
        if (c.containsKey('issues')) expect(issues, c['issues']);
        if (c.containsKey('message')) expect(message, c['message']);
        expect(warnings, c['warnings'] ?? isEmpty);
        expect(after, c['written'] ?? storedText);
        final succeeded = c['outcome'] == 'ok' || c['outcome'] == 'written';
        expect(
          ledgerLines(dir, kind),
          succeeded
              ? ['{"side":"$kind","action":"verified","file":"$relative"}']
              : isEmpty,
        );
        for (final text in c['absent'] as List<dynamic>? ?? const <dynamic>[]) {
          expect(message, isNot(contains(text)));
          for (final found in everyFileIn(dir)) {
            expect(found.readAsStringSync(), isNot(contains(text)),
                reason: found.path);
          }
        }
      });
    }
  });
}
