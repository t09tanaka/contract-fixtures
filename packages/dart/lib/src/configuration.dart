import 'dart:convert';
import 'dart:io';

import 'errors.dart';
import 'json.dart';
import 'pattern.dart';
import 'types.dart';
import 'validate.dart';

/// The file of a contracts directory that holds what is particular to a project.
const String configFile = 'config.json';

/// What `<contracts>/config.json` says. Without the file, nothing.
class ContractsConfig {
  const ContractsConfig({this.forbidden = const [], this.readers = const {}});

  /// Patterns of strings that must not be in a fixture (credentials with a shape of their
  /// own). A string is refused when a pattern matches anywhere in it.
  final List<String> forbidden;

  /// The readers of the directory, by name: the consumers that each have a ledger of
  /// their own. Without a declaration, none.
  final Map<String, ReaderConfig> readers;

  /// The names of the readers the configuration declares, sorted.
  List<String> get declaredReaders => readers.keys.toList()..sort();

  /// Whether the fixture `<kind>/<name>.json` is one that [reader] has to verify or read.
  ///
  /// Without a reader, every fixture is. The consumer fixtures of a reader are those
  /// whose name starts with the name of the reader and a dot.
  bool readerTakes(String? reader, FixtureKind kind, String name) {
    if (reader == null) return true;
    if (kind == FixtureKind.consumer) return name.startsWith('$reader.');
    final entries = kind == FixtureKind.provider
        ? readers[reader]?.provider
        : readers[reader]?.tables;
    return entries == null || entries.any((entry) => entryNames(entry, name));
  }

  /// Fails unless [reader] can be the reader of a consumer in a directory with this
  /// configuration: where readers are declared, it is one of them.
  void requireDeclaredReader(String? reader) {
    final declared = declaredReaders;
    if (declared.isEmpty || (reader != null && declared.contains(reader))) {
      return;
    }
    throw ContractUsageException(
      reader == null
          ? 'contract_fixtures: $configFile declares readers '
              '(${declared.join(', ')}): say which one this is'
          : 'contract_fixtures: $configFile declares no reader named $reader '
              '(declared: ${declared.join(', ')})',
    );
  }
}

/// What one reader reads. A kind that is left out means every fixture of that kind.
class ReaderConfig {
  const ReaderConfig({this.provider, this.tables});

  /// The provider fixtures the reader reads: names, or the start of names followed by
  /// `*`.
  final List<String>? provider;

  /// The tables the reader reads, written the same way.
  final List<String>? tables;
}

/// The name of a reader. Lower case only, so that two names never differ only in case.
final RegExp readerPattern = RegExp(r'^[a-z0-9][a-z0-9-]*$');

/// An entry of a reader: the name of a fixture, or the start of names followed by `*`.
final RegExp _entryPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]*\*?$');

/// Whether an entry of a reader names the fixture [name].
bool entryNames(String entry, String name) => entry.endsWith('*')
    ? name.startsWith(entry.substring(0, entry.length - 1))
    : entry == name;

/// A configuration, and how its file does not follow the format.
class ConfigValidation {
  const ConfigValidation(this.config, this.issues);

  /// What the file says when [issues] is empty; nothing otherwise.
  final ContractsConfig config;
  final List<FormatIssue> issues;
}

const List<String> _keys = ['format', 'forbidden', 'readers'];
const List<String> _readerKeys = ['provider', 'tables'];

Map<String, ReaderConfig> _validateReaders(
    Object? value, List<FormatIssue> issues) {
  final readers = <String, ReaderConfig>{};
  if (value is! Map<String, dynamic> || value.isEmpty) {
    issues.add(
      const FormatIssue(
        'readers',
        'readers',
        'must be an object that names at least one reader',
      ),
    );
    return readers;
  }
  for (final name in sortedKeys(value)) {
    final at = 'readers.$name';
    final reads = value[name];
    if (!readerPattern.hasMatch(name)) {
      issues.add(
        FormatIssue(
          'readers',
          at,
          'is not the name of a reader (lower-case letters, digits and -)',
        ),
      );
      continue;
    }
    if (reads is! Map<String, dynamic>) {
      issues.add(
        FormatIssue(
          'readers',
          at,
          'must be an object (empty for a reader that reads everything)',
        ),
      );
      continue;
    }
    for (final key in sortedKeys(reads)) {
      if (!_readerKeys.contains(key)) {
        issues.add(
          FormatIssue(
            'unknown-key',
            '$at.$key',
            'unknown key (allowed: ${_readerKeys.join(', ')})',
          ),
        );
      }
    }
    final lists = <String, List<String>>{};
    for (final key in _readerKeys) {
      if (!reads.containsKey(key)) continue;
      final entries = reads[key];
      if (entries is! List) {
        issues.add(
          FormatIssue(
              'readers', '$at.$key', 'must be an array of fixture names'),
        );
        continue;
      }
      for (var i = 0; i < entries.length; i++) {
        final entry = entries[i];
        if (entry is! String || !_entryPattern.hasMatch(entry)) {
          issues.add(
            FormatIssue(
              'readers',
              '$at.$key.$i',
              'must be the name of a fixture, or the start of names followed by *',
            ),
          );
        }
      }
      lists[key] = entries.whereType<String>().toList();
    }
    readers[name] = ReaderConfig(
      provider: lists['provider'],
      tables: lists['tables'],
    );
  }
  return readers;
}

/// Checks the text of a `config.json`.
ConfigValidation validateConfig(String text) {
  const none = ContractsConfig();
  final Object? value;
  try {
    value = jsonDecode(text.startsWith('﻿') ? text.substring(1) : text);
  } on FormatException {
    return const ConfigValidation(none, [
      FormatIssue('json', '(root)', 'is not valid JSON'),
    ]);
  }
  if (value is! Map<String, dynamic>) {
    return const ConfigValidation(none, [
      FormatIssue('root', '(root)', 'must be a JSON object'),
    ]);
  }
  final issues = <FormatIssue>[];
  for (final key in sortedKeys(value)) {
    if (!_keys.contains(key)) {
      issues.add(
        FormatIssue(
          'unknown-key',
          key,
          'unknown key (allowed: ${_keys.join(', ')})',
        ),
      );
    }
  }
  if (value['format'] is! num || value['format'] != formatVersion) {
    issues.add(
      const FormatIssue(
        'format',
        'format',
        'must be $formatVersion (this is the only format this version reads)',
      ),
    );
  }
  final forbidden =
      value.containsKey('forbidden') ? value['forbidden'] : const <dynamic>[];
  if (forbidden is! List) {
    issues.add(
      const FormatIssue(
          'forbidden', 'forbidden', 'must be an array of patterns'),
    );
  } else {
    for (var i = 0; i < forbidden.length; i++) {
      final pattern = forbidden[i];
      if (pattern is! String) {
        issues.add(
          FormatIssue(
              'forbidden', 'forbidden.$i', 'must be a pattern (a string)'),
        );
        continue;
      }
      try {
        if (compilePattern(pattern).search('')) {
          issues.add(
            FormatIssue(
              'pattern',
              'forbidden.$i',
              'matches the empty string, so it would forbid every string',
            ),
          );
        }
      } on PatternException catch (error) {
        issues.add(
          FormatIssue(
            'pattern',
            'forbidden.$i',
            'is not a pattern this format supports: ${error.message}',
          ),
        );
      }
    }
  }
  final readers = value.containsKey('readers')
      ? _validateReaders(value['readers'], issues)
      : const <String, ReaderConfig>{};
  if (issues.isNotEmpty || forbidden is! List) {
    return ConfigValidation(none, issues);
  }
  return ConfigValidation(
    ContractsConfig(
      forbidden: forbidden.cast<String>().toList(),
      readers: readers,
    ),
    issues,
  );
}

/// Reads `<dir>/config.json`. A directory without the file has a configuration that says
/// nothing. The file must be UTF-8 (a byte order mark is ignored), like a fixture.
ConfigValidation readConfig(String dir) {
  final file = File('$dir/$configFile');
  final type = FileSystemEntity.typeSync(file.path);
  if (type == FileSystemEntityType.notFound) {
    return const ConfigValidation(ContractsConfig(), []);
  }
  if (type != FileSystemEntityType.file) {
    return const ConfigValidation(ContractsConfig(), [
      FormatIssue('json', '(root)', 'is not a file'),
    ]);
  }
  final String text;
  try {
    text = utf8.decode(file.readAsBytesSync());
  } on FormatException {
    return const ConfigValidation(ContractsConfig(), [
      FormatIssue('json', '(root)', 'is not valid UTF-8'),
    ]);
  }
  return validateConfig(text);
}
