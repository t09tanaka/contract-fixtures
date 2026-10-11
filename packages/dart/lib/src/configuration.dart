import 'dart:convert';
import 'dart:io';

import 'json.dart';
import 'pattern.dart';
import 'types.dart';
import 'validate.dart';

/// The file of a contracts directory that holds what is particular to a project.
const String configFile = 'config.json';

/// What `<contracts>/config.json` says. Without the file, nothing.
class ContractsConfig {
  const ContractsConfig({this.forbidden = const []});

  /// Patterns of strings that must not be in a fixture (credentials with a shape of their
  /// own). A string is refused when a pattern matches anywhere in it.
  final List<String> forbidden;
}

/// A configuration, and how its file does not follow the format.
class ConfigValidation {
  const ConfigValidation(this.config, this.issues);

  /// What the file says when [issues] is empty; nothing otherwise.
  final ContractsConfig config;
  final List<FormatIssue> issues;
}

const List<String> _keys = ['format', 'forbidden'];

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
        compilePattern(pattern);
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
  if (issues.isNotEmpty || forbidden is! List) {
    return ConfigValidation(none, issues);
  }
  return ConfigValidation(
    ContractsConfig(forbidden: forbidden.cast<String>().toList()),
    issues,
  );
}

/// Reads `<dir>/config.json`. A directory without the file has a configuration that says
/// nothing. The file must be UTF-8 (a byte order mark is ignored), like a fixture.
ConfigValidation readConfig(String dir) {
  final file = File('$dir/$configFile');
  if (!file.existsSync()) return const ConfigValidation(ContractsConfig(), []);
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
