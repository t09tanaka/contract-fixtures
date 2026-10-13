import 'dart:convert';
import 'dart:io';

import 'configuration.dart';
import 'errors.dart';
import 'types.dart';

enum LedgerAction { verified, read }

/// The name of a ledger without `.jsonl`: the side, and for a consumer that is one reader
/// of several, the name of the reader after it (`consumer.web`).
///
/// Throws [ContractUsageException] for a reader on the provider side and for a name no
/// reader can have.
String ledgerName(ContractSide side, [String? reader]) {
  if (reader == null) return side.name;
  if (side != ContractSide.consumer) {
    throw const ContractUsageException(
      'contract_fixtures: a reader is a consumer: there is none on the provider side',
    );
  }
  if (!readerPattern.hasMatch(reader)) {
    throw ContractUsageException(
      'contract_fixtures: ${jsonEncode(reader)} is not the name of a reader '
      '(lower-case letters, digits and -)',
    );
  }
  return '${side.name}.$reader';
}

File ledgerFile(String dir, ContractSide side, [String? reader]) =>
    File('$dir/.ledger/${ledgerName(side, reader)}.jsonl');

/// Whether [file] may be there although it cannot be looked at: `typeSync` answers "not
/// found" for every path it cannot reach, also for one in a directory that cannot be
/// read. Throws [FileSystemException] when the directory cannot be listed.
bool _hidden(File file) {
  final parent = file.parent;
  if (FileSystemEntity.typeSync(parent.path) !=
      FileSystemEntityType.directory) {
    return false;
  }
  final name = file.uri.pathSegments.last;
  return parent.listSync().any(
        (entity) =>
            entity.uri.pathSegments.lastWhere((s) => s.isNotEmpty) == name,
      );
}

/// Runs one operation on a ledger; [operation] is told whether the file exists. Whatever
/// goes wrong with the file (a directory in its place, a path that cannot be read or
/// written) is reported in the same words by every implementation, and never passed over.
T _onLedger<T>(String name, File file, T Function(bool exists) operation) {
  try {
    final type = FileSystemEntity.typeSync(file.path);
    if (type == FileSystemEntityType.file ||
        (type == FileSystemEntityType.notFound && !_hidden(file))) {
      return operation(type == FileSystemEntityType.file);
    }
  } on FileSystemException {
    // reported below
  }
  throw ContractUsageException(
    'contract_fixtures: the ledger .ledger/$name.jsonl cannot be used '
    '(it is not a file, or it cannot be read or written)',
  );
}

void appendLedger(
  String dir,
  ContractSide side,
  LedgerAction action,
  FixtureKind kind,
  String name, [
  String? reader,
]) {
  final file = ledgerFile(dir, side, reader);
  final entry = {
    'side': side.name,
    'action': action.name,
    'file': '${kind.name}/$name.json',
  };
  _onLedger(ledgerName(side, reader), file, (_) {
    file.parent.createSync(recursive: true);
    file.writeAsStringSync('${jsonEncode(entry)}\n', mode: FileMode.append);
  });
}

/// Forgets what earlier test runs of one side did (with [reader], of that reader alone).
/// Run it before that side's tests.
///
/// Throws [ContractUsageException] when the ledger cannot be removed.
void resetLedger({
  required String dir,
  required ContractSide side,
  String? reader,
}) {
  final file = ledgerFile(dir, side, reader);
  _onLedger(ledgerName(side, reader), file, (exists) {
    if (exists) file.deleteSync();
  });
}

/// A line that holds nothing but spaces, tabs and carriage returns (the same in every
/// implementation).
final RegExp _blank = RegExp(r'^[ \t\r]*$');

/// The `action:file` keys of one side's ledger, the files its entries name (one per
/// entry), the line numbers that could not be parsed, and whether the file exists at all.
/// Throws [ContractUsageException] when it is there and cannot be read.
({Set<String> done, List<String> files, List<int> badLines, bool exists})
    readLedger(
  String dir,
  ContractSide side, [
  String? reader,
]) {
  final done = <String>{};
  final files = <String>[];
  final badLines = <int>[];
  final file = ledgerFile(dir, side, reader);
  final bytes = _onLedger(
    ledgerName(side, reader),
    file,
    (exists) => exists ? file.readAsBytesSync() : null,
  );
  if (bytes == null) {
    return (done: done, files: files, badLines: badLines, exists: false);
  }
  // Lenient decoding: a damaged line is reported as a bad line, not as a crash. A byte
  // order mark is not a part of the first line.
  var text = utf8.decode(bytes, allowMalformed: true);
  if (text.startsWith('\uFEFF')) text = text.substring(1);
  final lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    if (_blank.hasMatch(line)) continue;
    try {
      final entry = jsonDecode(line) as Object?;
      if (entry is Map<String, dynamic> &&
          entry['side'] == side.name &&
          (entry['action'] == 'verified' || entry['action'] == 'read') &&
          entry['file'] is String) {
        done.add('${entry['action']}:${entry['file']}');
        files.add(entry['file'] as String);
        continue;
      }
    } on FormatException {
      // fall through
    }
    badLines.add(i + 1);
  }
  return (done: done, files: files, badLines: badLines, exists: true);
}
