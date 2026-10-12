import 'dart:io';

import 'configuration.dart';
import 'errors.dart';
import 'ledger.dart';
import 'types.dart';
import 'validate.dart';

/// One reason the check fails.
class CheckProblem {
  const CheckProblem(this.file, this.code, this.message);

  /// `<kind>/<name>.json`, `config.json`, `.ledger/<side>.jsonl`, or `''` for the
  /// directory as a whole.
  final String file;

  /// `invalid`, `unverified`, `unread`, `ledger` or `empty`.
  final String code;
  final String message;
}

class CheckResult {
  const CheckResult(
    this.side,
    this.fixtures,
    this.problems, [
    this.hints = const [],
  ]) : untouched = false;

  const CheckResult._(
    this.side,
    this.fixtures,
    this.problems,
    this.hints,
    this.untouched,
  );

  final ContractSide side;

  /// Number of fixture files found.
  final int fixtures;
  final List<CheckProblem> problems;

  /// What the state of the ledger suggests about the cause of `unverified` and `unread`
  /// problems. Guesses, worded as such; they never change [problems].
  final List<String> hints;

  /// Whether this side's ledger has no entries, so that none of the fixtures that follow
  /// the format was verified or read. The report then gives their number instead of one
  /// line each.
  final bool untouched;
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
  final onDisk = <String>{};
  var fixtures = 0;
  var asked = 0;
  var missing = 0;
  // A configuration that is not valid is a problem of its own; the fixtures are then
  // checked as if there were none.
  final configuration = readConfig(dir);
  for (final issue in configuration.issues) {
    problems.add(
      CheckProblem(
        configFile,
        'invalid',
        'invalid configuration: ${issue.path} ${issue.message}',
      ),
    );
  }

  for (final kind in FixtureKind.values) {
    for (final name in listFixtureNames(dir, kind)) {
      fixtures++;
      final file = '${kind.name}/$name.json';
      onDisk.add(file);
      final issues = validateFixtureFile(
        kind,
        name,
        File('$dir/${kind.name}/$name.json'),
        configuration.config,
      ).issues;
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
      asked++;
      if (!ledger.done.contains('${action.name}:$file')) {
        missing++;
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
  final other = side == ContractSide.provider
      ? ContractSide.consumer
      : ContractSide.provider;
  final hints = _checkHints(
    side: side.name,
    other: other.name,
    asked: asked,
    missing: missing,
    ledgerExists: ledger.exists,
    lines: ledger.files.length,
    otherLines: missing > 0 ? _otherEntries(dir, other) : 0,
    gone: ledger.files.toSet().difference(onDisk).length,
  );
  return CheckResult._(
    side,
    fixtures,
    problems,
    hints,
    ledger.files.isEmpty && asked > 0,
  );
}

/// The entries in the other side's ledger: only a hint depends on them, so a ledger that
/// cannot be read has none.
int _otherEntries(String dir, ContractSide other) {
  try {
    return readLedger(dir, other).files.length;
  } on ContractUsageException {
    return 0;
  }
}

/// Hints for a check with `unverified` or `unread` problems, from what the ledger looks
/// like. At most two. The wording is pinned by spec/fixtures/check.json for every
/// implementation.
///
/// [asked] counts the fixtures that follow the format (each needs one verify or read of
/// this side), [missing] those of them that have none, [lines] and [otherLines] the entries
/// in this side's ledger and in the other side's, and [gone] the files this side's ledger
/// names that are not in the directory.
List<String> _checkHints({
  required String side,
  required String other,
  required int asked,
  required int missing,
  required bool ledgerExists,
  required int lines,
  required int otherLines,
  required int gone,
}) {
  if (missing == 0) return const [];
  final hints = <String>[];
  final ledger = '.ledger/$side.jsonl';
  if (lines == 0) {
    final what =
        ledgerExists ? '$ledger has no entries' : '$ledger does not exist';
    hints.add(
      otherLines > 0
          ? '$what, but .ledger/$other.jsonl has some. '
              "Did the $side side's tests run, and is $side the side to check?"
          : "$what. Did the $side side's tests run, "
              'and do they use this contracts directory?',
    );
  } else if (missing == asked) {
    hints.add(
      "$ledger has $lines entr${lines == 1 ? 'y' : 'ies'}, "
      'but none that this check asks for. '
      "Did the $side side's tests run since the fixtures changed?",
    );
  } else if (missing * 2 > asked) {
    hints.add(
      'Only ${asked - missing} of the $asked fixtures that follow the format '
      'were verified or read. '
      'If a part of the tests ran (a filter, one shard of several), run all of them, '
      'or join the ledgers of all shards, before this check.',
    );
  }
  if (gone > 0) {
    hints.add(
      '$ledger names $gone file(s) that are not in this directory. '
      'It may be left from an earlier run: run the reset before the tests.',
    );
  }
  return hints;
}

/// The name users type, the first word of what the commands print. The TypeScript package
/// prints `contract-fixtures`.
const String executable = 'contract_fixtures';

/// The report the `check` command prints.
String formatCheckResult(CheckResult result) {
  final head = '$executable check (${result.side.name} side)';
  if (result.problems.isEmpty) {
    return "$head: OK (${result.fixtures} fixture(s), all verified or read by this side's tests)";
  }
  bool untouched(CheckProblem p) =>
      result.untouched && (p.code == 'unverified' || p.code == 'unread');
  final count = result.problems.where(untouched).length;
  final first = result.problems.indexWhere(untouched);
  return [
    '$head: ${result.problems.length} problem(s) in ${result.fixtures} fixture(s)',
    for (final (i, p) in result.problems.indexed)
      // One line in the place of the first of them, when all were left alone.
      if (!untouched(p))
        '  - ${p.file.isEmpty ? '' : '${p.file}: '}${p.message}'
      else if (i == first)
        '  - none of the $count fixture(s) that follow the format was verified or read by '
            "the ${result.side.name} side's tests (they are not listed one by one)",
    for (final hint in result.hints) 'Hint: $hint',
    "Run `$executable reset` and the ${result.side.name} side's tests before this check.",
  ].join('\n');
}
