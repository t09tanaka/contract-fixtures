// Runs the language independent cases in spec/fixtures. The TypeScript package runs the
// same files; that both pass is what "the two packages treat a fixture the same way" means.
import 'dart:convert';
import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';
import 'package:test/test.dart';

import 'helpers.dart';

void main() {
  group('spec/fixtures/differences.json', () {
    for (final c in loadCases('differences.json')) {
      test(c['case'], () {
        final diffs = differences(
          c['expected'],
          c['actual'],
          (c['volatile'] as List<dynamic>).cast<String>(),
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
        final issues = c.containsKey('text')
            ? validateFixture(kind, name, c['text'] as String).issues
            : validateFixtureValue(kind, name, c['value']);
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
        writeFile(dir, '.ledger/${side.name}.jsonl', lines(c['ledger']));
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
        final contract = ContractFixtures(
          side: ContractSide.values.byName(kind),
          dir: dir,
          update: c['update'] as bool,
        );
        final request = ExchangeRequest.fromJson(
          observed['request'] as Map<String, dynamic>,
        );
        final volatile =
            (observed['volatile'] as List<dynamic>? ?? const <dynamic>[])
                .cast<String>();
        final secret = (observed['secret'] as Map<String, dynamic>? ??
                const <String, dynamic>{})
            .cast<String, String>();

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
          outcome =
              storedText == null && c['update'] == false && error.issues.isEmpty
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
