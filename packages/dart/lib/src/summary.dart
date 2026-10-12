import 'dart:io';

import 'check.dart';
import 'configuration.dart';
import 'errors.dart';
import 'json.dart';
import 'types.dart';
import 'validate.dart';

/// One fixture, as the `summary` command prints it.
class FixtureSummary {
  const FixtureSummary({
    required this.kind,
    required this.name,
    required this.valid,
    this.method,
    this.path,
    this.status,
    this.body = '-',
  });

  final FixtureKind kind;
  final String name;

  /// Whether the file follows the format. The other members are `null` or `'-'` when not.
  final bool valid;

  /// `null` for a table.
  final String? method;
  final String? path;

  /// `null` for a consumer fixture and a table.
  final int? status;

  /// The response body: `{error: string, available: number}` with the keys in code unit
  /// order (objects inside it are opened up to the depth asked for), `array(3)`, the type
  /// of a scalar, or `-` without a body. For a table, the number of rows.
  final String body;
}

final RegExp _plainKey = RegExp(r'^[A-Za-z0-9_.-]+$');

/// Whether the elements of an array have more than one JSON type.
bool _mixed(List<dynamic> items) =>
    items.any((item) => jsonType(item) != jsonType(items.first));

/// A value with [depth] levels left to open. An object costs a level: its keys with what
/// their values are. An array costs none: it stands for its first element, in brackets.
String _opened(Object? value, int depth) {
  if (depth < 1) return jsonType(value);
  if (value is List) {
    if (value.isEmpty) return '[]';
    return _mixed(value) ? '[mixed]' : '[${_opened(value.first, depth)}]';
  }
  if (value is! Map<String, dynamic>) return jsonType(value);
  final parts = [
    for (final key in sortedKeys(value))
      '${_plainKey.hasMatch(key) ? key : compactJson(key)}: '
          '${_opened(value[key], depth - 1)}',
  ];
  return '{${parts.join(', ')}}';
}

/// A body: its keys with the JSON type of each value, [depth] levels deep.
String _shape(Map<String, dynamic>? response, int depth) {
  if (response == null || !response.containsKey('body')) return '-';
  final body = response['body'];
  if (body is List) {
    // The top level of an array is its length; from depth 2 on, its first element follows.
    final head = 'array(${body.length})';
    if (depth < 2 || body.isEmpty) return head;
    return '$head of ${_mixed(body) ? 'mixed' : _opened(body.first, depth - 1)}';
  }
  return _opened(body, depth);
}

/// The deepest level the summary opens.
const int maxSummaryDepth = 9;

/// Every fixture of a contracts directory in one row each, to read them side by side:
/// which status an exchange has, and which keys its response body has. With [depth] 2 (or
/// more, up to 9) the objects inside the body are opened as well. Reads the files only; the
/// ledger is neither read nor written.
List<FixtureSummary> summarizeContracts({required String dir, int depth = 1}) {
  if (depth < 1 || depth > maxSummaryDepth) {
    throw const ContractUsageException(
      'contract_fixtures: depth must be a whole number from 1 to $maxSummaryDepth',
    );
  }
  final rows = <FixtureSummary>[];
  final config = readConfig(dir).config;
  for (final kind in FixtureKind.values) {
    for (final name in listFixtureNames(dir, kind)) {
      final result = validateFixtureFile(
        kind,
        name,
        File('$dir/${kind.name}/$name.json'),
        config,
      );
      if (result.issues.isNotEmpty) {
        rows.add(FixtureSummary(kind: kind, name: name, valid: false));
        continue;
      }
      final value = result.value as Map<String, dynamic>;
      if (kind == FixtureKind.tables) {
        final count = (value['rows'] as List<dynamic>).length;
        rows.add(
          FixtureSummary(
            kind: kind,
            name: name,
            valid: true,
            body: '$count row(s)',
          ),
        );
        continue;
      }
      final request = value['request'] as Map<String, dynamic>;
      final response = value['response'] as Map<String, dynamic>?;
      rows.add(
        FixtureSummary(
          kind: kind,
          name: name,
          valid: true,
          method: request['method'] as String,
          path: request['path'] as String,
          status: (response?['status'] as num?)?.toInt(),
          body: _shape(response, depth),
        ),
      );
    }
  }
  return rows;
}

/// The text the `summary` command prints: a header and one line per fixture, in columns
/// that are padded with spaces (counted in UTF-16 code units, so every implementation
/// prints the same text).
String formatSummary(List<FixtureSummary> rows) {
  final cells = [
    ['FIXTURE', 'REQUEST', 'STATUS', 'RESPONSE BODY'],
    for (final row in rows)
      [
        '${row.kind.name}/${row.name}',
        row.method == null ? '-' : '${row.method} ${row.path}',
        row.status == null ? '-' : '${row.status}',
        row.valid ? row.body : '(does not follow the format; see check)',
      ],
  ];
  final widths = [
    for (var column = 0; column < 3; column++)
      cells.map((line) => line[column].length).reduce((a, b) => a > b ? a : b),
  ];
  return [
    for (final line in cells)
      [
        for (var column = 0; column < 4; column++)
          column < 3 ? line[column].padRight(widths[column]) : line[column],
      ].join('  '),
  ].join('\n');
}
