import 'dart:io';

import 'check.dart';
import 'configuration.dart';
import 'contract.dart';
import 'errors.dart';
import 'ledger.dart';
import 'summary.dart';
import 'types.dart';
import 'version.dart';

/// The text printed for `--help` and after a usage error.
const String usage = '''
$executable — shared request/response fixtures that keep an API and its clients in step

Usage: $executable <reset|check> --side <provider|consumer> [--reader <name>] [--dir <contracts>]
       $executable summary [--dir <contracts>] [--depth <n>]

Commands:
  reset    Forget what earlier test runs of this side did. Run it before the tests.
  check    Fail unless this side's tests verified or read every fixture since the reset,
           and every fixture follows the format. Run it after all tests of this side.
  summary  Print one line per fixture: request, status, and the keys of the response body
           with their types. Does not touch the ledger.

Options:
  --side <provider|consumer>  The side whose tests ran. Not for summary
  --reader <name>             With --side consumer, in a directory with more than one
                              consumer: the reader whose tests ran. Without it, every
                              reader that config.json declares, one after the other
  --dir <contracts>           The contracts directory: the one that holds provider/, consumer/
                              and tables/, not the directory of a package
                              (default: the environment variable $dirEnv)
  --depth <n>                 For summary: how many levels of objects in the response body
                              to open, 1 to 9 (default: 1, the keys at the top)
  -h, --help                  Show this help
  -v, --version               Show the version

Exit codes: 0 no problems, 1 problems found (summary: no fixtures) or the command could
not finish, 2 wrong usage''';

final RegExp _option =
    RegExp(r'^--(side|reader|dir|depth)(?:=(.*))?$', dotAll: true);
final RegExp _depth = RegExp(r'^[1-9]$');

/// Runs the command line and returns the exit code.
int runCli(
  List<String> arguments, {
  required void Function(String text) out,
  required void Function(String text) err,
  Map<String, String>? environment,
}) {
  int wrong(String message) {
    err('$executable: $message\n\n$usage');
    return 2;
  }

  String? command;
  final values = <String, String>{};
  for (var i = 0; i < arguments.length; i++) {
    final arg = arguments[i];
    if (arg == '--help' || arg == '-h') {
      out(usage);
      return 0;
    }
    if (arg == '--version' || arg == '-v') {
      out(packageVersion);
      return 0;
    }
    final option = _option.firstMatch(arg);
    if (option != null) {
      var value = option.group(2);
      if (value == null) {
        if (++i >= arguments.length) {
          return wrong('--${option.group(1)} needs a value');
        }
        value = arguments[i];
      }
      values[option.group(1)!] = value;
    } else if (arg.startsWith('-')) {
      return wrong('unknown option: $arg');
    } else if (command == null) {
      command = arg;
    } else {
      return wrong('unexpected argument: $arg');
    }
  }
  if (command == null) return wrong('no command given');
  if (command != 'check' && command != 'reset' && command != 'summary') {
    return wrong('unknown command: $command');
  }
  var side = ContractSide.provider;
  final reader = values['reader'];
  if (command == 'summary') {
    if (values.containsKey('side')) return wrong('summary takes no --side');
    if (reader != null) return wrong('summary takes no --reader');
    if (values.containsKey('depth') && !_depth.hasMatch(values['depth']!)) {
      return wrong('--depth must be a whole number from 1 to 9');
    }
  } else {
    switch (values['side']) {
      case 'provider':
        side = ContractSide.provider;
      case 'consumer':
        side = ContractSide.consumer;
      default:
        return wrong('--side must be provider or consumer');
    }
    if (values.containsKey('depth')) {
      return wrong('--depth is for summary only');
    }
    if (reader != null && side != ContractSide.consumer) {
      return wrong('--reader is for --side consumer only');
    }
    if (reader != null && !readerPattern.hasMatch(reader)) {
      return wrong(
        '--reader must be the name of a reader (lower-case letters, digits and -)',
      );
    }
  }
  final given = values['dir'] ?? (environment ?? Platform.environment)[dirEnv];
  if (given == null || given.isEmpty) return wrong('pass --dir or set $dirEnv');
  if (!Directory(given).existsSync()) return wrong('$given is not a directory');
  final dir = Directory(given).absolute.path;

  try {
    if (command == 'summary') {
      final rows = summarizeContracts(
        dir: dir,
        depth: int.parse(values['depth'] ?? '1'),
      );
      if (rows.isEmpty) {
        err(
          '$executable summary: no fixtures found under provider/, '
          'consumer/ or tables/ (wrong directory?)',
        );
        return 1;
      }
      out(formatSummary(rows));
      return 0;
    }
    // On the consumer side of a directory that declares readers, a command without
    // --reader is for each of them in turn. Everywhere else there is one ledger.
    final config = readConfig(dir).config;
    if (side == ContractSide.consumer && reader != null) {
      config.requireDeclaredReader(reader);
    }
    final declared = side == ContractSide.consumer && reader == null
        ? config.declaredReaders
        : const <String>[];
    var code = 0;
    for (final one in declared.isNotEmpty ? declared : [reader]) {
      final of = one == null ? '' : ', reader $one';
      if (command == 'reset') {
        resetLedger(dir: dir, side: side, reader: one);
        out(
          '$executable reset (${side.name} side$of): '
          'OK (no entries in .ledger/${ledgerName(side, one)}.jsonl)',
        );
        continue;
      }
      final result = checkContracts(dir: dir, side: side, reader: one);
      final report = formatCheckResult(result);
      if (result.problems.isNotEmpty) {
        err(report);
        code = 1;
      } else {
        out(report);
      }
    }
    return code;
  } on ContractUsageException catch (error) {
    // A ledger that cannot be used says so in words of its own.
    err(error.message);
    return 1;
  } on Object catch (error) {
    // Anything else is a failure of the file system; the first line is the same in every
    // implementation.
    err('$executable: $command could not finish\n$error');
    return 1;
  }
}
