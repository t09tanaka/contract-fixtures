import 'dart:convert';
import 'dart:io';

/// The shared, language independent cases. `dart test` runs with the package root as the
/// working directory.
const String specFixtures = '../../spec/fixtures';

List<Map<String, dynamic>> loadCases(String file) {
  final parsed = jsonDecode(File('$specFixtures/$file').readAsStringSync())
      as Map<String, dynamic>;
  return (parsed['cases'] as List<dynamic>).cast<Map<String, dynamic>>();
}

/// The text of the help in spec/fixtures/cli.json, with {tool} for the name of the executable.
String loadHelp() {
  final parsed = jsonDecode(File('$specFixtures/cli.json').readAsStringSync())
      as Map<String, dynamic>;
  return parsed['help'] as String;
}

String tempDir() =>
    Directory.systemTemp.createTempSync('contract-fixtures-').path;

void _copy(Directory from, Directory to) {
  to.createSync(recursive: true);
  for (final entity in from.listSync()) {
    final name = entity.uri.pathSegments.lastWhere((s) => s.isNotEmpty);
    if (entity is Directory) {
      _copy(entity, Directory('${to.path}/$name'));
    } else if (entity is File) {
      entity.copySync('${to.path}/$name');
    }
  }
}

/// A fresh copy of spec/fixtures/contracts.
String copyOfContracts() {
  final dir = tempDir();
  _copy(Directory('$specFixtures/contracts'), Directory(dir));
  return dir;
}

void writeFile(String dir, String relative, String text) {
  File('$dir/$relative')
    ..parent.createSync(recursive: true)
    ..writeAsStringSync(text);
}

List<String> ledgerLines(String dir, String side) {
  final file = File('$dir/.ledger/$side.jsonl');
  if (!file.existsSync()) return [];
  return file
      .readAsStringSync()
      .split('\n')
      .where((l) => l.isNotEmpty)
      .toList();
}

/// Every file below [dir], the ledger included.
List<File> everyFileIn(String dir) =>
    Directory(dir).listSync(recursive: true).whereType<File>().toList();
