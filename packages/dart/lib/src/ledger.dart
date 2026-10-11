import 'dart:convert';
import 'dart:io';

import 'types.dart';

enum LedgerAction { verified, read }

File ledgerFile(String dir, ContractSide side) =>
    File('$dir/.ledger/${side.name}.jsonl');

void appendLedger(
  String dir,
  ContractSide side,
  LedgerAction action,
  FixtureKind kind,
  String name,
) {
  final file = ledgerFile(dir, side);
  file.parent.createSync(recursive: true);
  final entry = {
    'side': side.name,
    'action': action.name,
    'file': '${kind.name}/$name.json',
  };
  file.writeAsStringSync('${jsonEncode(entry)}\n', mode: FileMode.append);
}

/// Forgets what earlier test runs of one side did. Run it before that side's tests.
void resetLedger({required String dir, required ContractSide side}) {
  final file = ledgerFile(dir, side);
  if (file.existsSync()) file.deleteSync();
}

/// The `action:file` keys of one side's ledger, and the line numbers that could not be
/// parsed.
({Set<String> done, List<int> badLines}) readLedger(
  String dir,
  ContractSide side,
) {
  final done = <String>{};
  final badLines = <int>[];
  final file = ledgerFile(dir, side);
  if (!file.existsSync()) return (done: done, badLines: badLines);
  // Lenient decoding: a damaged line is reported as a bad line, not as a crash.
  final lines =
      utf8.decode(file.readAsBytesSync(), allowMalformed: true).split('\n');
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    if (line.trim().isEmpty) continue;
    try {
      final entry = jsonDecode(line) as Object?;
      if (entry is Map<String, dynamic> &&
          entry['side'] == side.name &&
          (entry['action'] == 'verified' || entry['action'] == 'read') &&
          entry['file'] is String) {
        done.add('${entry['action']}:${entry['file']}');
        continue;
      }
    } on FormatException {
      // fall through
    }
    badLines.add(i + 1);
  }
  return (done: done, badLines: badLines);
}
