import 'dart:io';

import 'package:contract_fixtures/contract_fixtures.dart';

void main(List<String> arguments) {
  exitCode = runCli(arguments, out: stdout.writeln, err: stderr.writeln);
}
