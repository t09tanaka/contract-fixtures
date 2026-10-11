import 'dart:io';

import 'check.dart';
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

  /// The top level of the response body: `{error: string, available: number}` with the keys
  /// in code unit order, `array(3)`, the type of a scalar, or `-` without a body. For a
  /// table, the number of rows.
  final String body;
}

final RegExp _plainKey = RegExp(r'^[A-Za-z0-9_.-]+$');

/// The top level of a body: its keys with the JSON type of each value.
String _shape(Map<String, dynamic>? response) {
  if (response == null || !response.containsKey('body')) return '-';
  final body = response['body'];
  if (body is List) return 'array(${body.length})';
  if (body is! Map<String, dynamic>) return jsonType(body);
  final members = [
    for (final key in sortedKeys(body))
      '${_plainKey.hasMatch(key) ? key : compactJson(key)}: ${jsonType(body[key])}',
  ];
  return '{${members.join(', ')}}';
}

/// Every fixture of a contracts directory in one row each, to read them side by side:
/// which status an exchange has, and which keys its response body has. Reads the files
/// only; the ledger is neither read nor written.
List<FixtureSummary> summarizeContracts({required String dir}) {
  final rows = <FixtureSummary>[];
  for (final kind in FixtureKind.values) {
    for (final name in listFixtureNames(dir, kind)) {
      final result = validateFixtureFile(
        kind,
        name,
        File('$dir/${kind.name}/$name.json'),
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
          body: _shape(response),
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
