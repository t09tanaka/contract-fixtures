import 'dart:io';

import 'check.dart';
import 'contract.dart';
import 'ledger.dart';
import 'types.dart';

/// The text printed for `--help` and after a usage error.
const String usage = '''
Usage: contract_fixtures <command> --side <provider|consumer> [--dir <contracts>]

Commands:
  reset   Forget what earlier test runs of this side did. Run it before the tests.
  check   Fail unless this side's tests verified or read every fixture since the reset,
          and every fixture follows the format.

Options:
  --side  The side whose tests ran: provider or consumer.
  --dir   The contracts directory. Defaults to the environment variable $dirEnv.

Exit codes: 0 no problems, 1 problems found, 2 wrong usage.''';

final RegExp _option = RegExp(r'^--(side|dir)(?:=(.*))?$', dotAll: true);

/// Runs the command line and returns the exit code.
int runCli(
  List<String> arguments, {
  required void Function(String text) out,
  required void Function(String text) err,
  Map<String, String>? environment,
}) {
  int wrong(String message) {
    err('contract_fixtures: $message\n\n$usage');
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
      return wrong('unknown option $arg');
    } else if (command == null) {
      command = arg;
    } else {
      return wrong('unexpected argument $arg');
    }
  }
  if (command == null) return wrong('missing command');
  if (command != 'check' && command != 'reset') {
    return wrong('unknown command $command');
  }
  final ContractSide side;
  switch (values['side']) {
    case 'provider':
      side = ContractSide.provider;
    case 'consumer':
      side = ContractSide.consumer;
    default:
      return wrong('--side must be provider or consumer');
  }
  final given = values['dir'] ?? (environment ?? Platform.environment)[dirEnv];
  if (given == null || given.isEmpty) return wrong('pass --dir or set $dirEnv');
  if (!Directory(given).existsSync()) return wrong('$given is not a directory');
  final dir = Directory(given).absolute.path;

  if (command == 'reset') {
    resetLedger(dir: dir, side: side);
    return 0;
  }
  final result = checkContracts(dir: dir, side: side);
  final report = formatCheckResult(result);
  if (result.problems.isNotEmpty) {
    err(report);
    return 1;
  }
  out(report);
  return 0;
}
