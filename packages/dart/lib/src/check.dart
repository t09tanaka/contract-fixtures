import 'dart:io';

import 'ledger.dart';
import 'types.dart';
import 'validate.dart';

/// One reason the check fails.
class CheckProblem {
  const CheckProblem(this.file, this.code, this.message);

  /// `<kind>/<name>.json`, `.ledger/<side>.jsonl`, or `''` for the directory as a whole.
  final String file;

  /// `invalid`, `unverified`, `unread`, `ledger` or `empty`.
  final String code;
  final String message;
}

class CheckResult {
  const CheckResult(this.side, this.fixtures, this.problems);

  final ContractSide side;

  /// Number of fixture files found.
  final int fixtures;
  final List<CheckProblem> problems;
}

/// What one side has to do with each kind of fixture.
LedgerAction requiredAction(ContractSide side, FixtureKind kind) =>
    kind.name == side.name ? LedgerAction.verified : LedgerAction.read;

/// Names (file names without `.json`) of the fixtures of one kind, sorted.
List<String> listFixtureNames(String dir, FixtureKind kind) {
  final kindDir = Directory('$dir/${kind.name}');
  if (!kindDir.existsSync()) return [];
  return kindDir
      .listSync()
      .whereType<File>()
      .map((file) => file.uri.pathSegments.last)
      .where((name) => name.endsWith('.json'))
      .map((name) => name.substring(0, name.length - '.json'.length))
      .toList()
    ..sort();
}

/// Compares the fixtures on disk with one side's ledger: every fixture must follow the
/// format, and this side's tests must have verified or read each of them since the last
/// reset.
CheckResult checkContracts({required String dir, required ContractSide side}) {
  final problems = <CheckProblem>[];
  final ledger = readLedger(dir, side);
  var fixtures = 0;

  for (final kind in FixtureKind.values) {
    for (final name in listFixtureNames(dir, kind)) {
      fixtures++;
      final file = '${kind.name}/$name.json';
      final text = File('$dir/${kind.name}/$name.json').readAsStringSync();
      final issues = validateFixture(kind, name, text).issues;
      if (issues.isNotEmpty) {
        for (final issue in issues) {
          problems.add(
            CheckProblem(
              file,
              'invalid',
              'invalid fixture: ${issue.path} ${issue.message}',
            ),
          );
        }
        continue;
      }
      final action = requiredAction(side, kind);
      if (!ledger.done.contains('${action.name}:$file')) {
        problems.add(
          action == LedgerAction.verified
              ? CheckProblem(
                  file,
                  'unverified',
                  "not verified by the ${side.name} side's tests "
                      '(stale: delete it, or restore the test that produces it)',
                )
              : CheckProblem(
                  file,
                  'unread',
                  "not read by the ${side.name} side's tests "
                      '(add a test that feeds it to the real code)',
                ),
        );
      }
    }
  }
  for (final line in ledger.badLines) {
    problems.add(
      CheckProblem(
        '.ledger/${side.name}.jsonl',
        'ledger',
        'line $line is not a ledger entry of the ${side.name} side',
      ),
    );
  }
  if (fixtures == 0) {
    problems.add(
      const CheckProblem(
        '',
        'empty',
        'no fixtures found under provider/, consumer/ or tables/ (wrong directory?)',
      ),
    );
  }
  return CheckResult(side, fixtures, problems);
}

/// The report the `check` command prints.
String formatCheckResult(CheckResult result) {
  final head = 'contract-fixtures check (${result.side.name} side)';
  if (result.problems.isEmpty) {
    return "$head: ${result.fixtures} fixture(s), all verified or read by this side's tests.";
  }
  return [
    '$head: ${result.problems.length} problem(s) in ${result.fixtures} fixture(s)',
    for (final p in result.problems)
      '  - ${p.file.isEmpty ? '' : '${p.file}: '}${p.message}',
    "Run `contract_fixtures reset` and the ${result.side.name} side's tests before this check.",
  ].join('\n');
}
