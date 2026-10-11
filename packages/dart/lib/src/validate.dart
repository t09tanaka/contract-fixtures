import 'dart:convert';

import 'differences.dart';
import 'json.dart';
import 'types.dart';

/// One way in which a file does not follow the fixture format.
class FormatIssue {
  const FormatIssue(this.code, this.path, this.message);

  /// A stable identifier, the same in every implementation: `json`, `root`, `format`,
  /// `name`, `description`, `unknown-key`, `request`, `method`, `path`, `headers`, `body`,
  /// `response`, `status`, `volatile`, `volatile-unmatched` or `rows`.
  final String code;

  /// Where in the file, as a dot separated path (`(root)` for the file itself).
  final String path;
  final String message;

  @override
  String toString() => '$path: $message';
}

/// The result of [validateFixture].
class FixtureValidation {
  const FixtureValidation(this.value, this.issues);

  /// The decoded file, or `null` when it is not JSON.
  final Object? value;
  final List<FormatIssue> issues;
}

final RegExp namePattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]*$');
final RegExp _method = RegExp(r'^[A-Z]+$');

const Map<FixtureKind, List<String>> _topLevel = {
  FixtureKind.provider: [
    'format',
    'name',
    'description',
    'request',
    'response',
    'volatile',
  ],
  FixtureKind.consumer: [
    'format',
    'name',
    'description',
    'request',
    'volatile'
  ],
  FixtureKind.tables: ['format', 'name', 'description', 'rows'],
};

bool _isInteger(Object? value) =>
    value is int ||
    (value is double && value.isFinite && value == value.truncateToDouble());

void _unknownKeys(
  List<FormatIssue> issues,
  Map<String, dynamic> value,
  List<String> allowed,
  String prefix,
) {
  for (final key in sortedKeys(value)) {
    if (!allowed.contains(key)) {
      issues.add(
        FormatIssue(
          'unknown-key',
          prefix.isEmpty ? key : '$prefix.$key',
          'unknown key (allowed: ${allowed.join(', ')})',
        ),
      );
    }
  }
}

void _validateRequest(List<FormatIssue> issues, Object? request) {
  if (request is! Map<String, dynamic>) {
    issues.add(const FormatIssue('request', 'request', 'must be an object'));
    return;
  }
  _unknownKeys(
      issues, request, const ['method', 'path', 'headers', 'body'], 'request');
  final method = request['method'];
  if (method is! String || !_method.hasMatch(method)) {
    issues.add(
      const FormatIssue(
        'method',
        'request.method',
        'must be an upper-case HTTP method',
      ),
    );
  }
  final path = request['path'];
  if (path is! String || !path.startsWith('/')) {
    issues.add(
      const FormatIssue(
        'path',
        'request.path',
        'must be a string that starts with /',
      ),
    );
  }
  if (request.containsKey('headers')) {
    final headers = request['headers'];
    if (headers is! Map<String, dynamic>) {
      issues.add(
        const FormatIssue('headers', 'request.headers', 'must be an object'),
      );
    } else {
      for (final key in sortedKeys(headers)) {
        if (key != key.toLowerCase()) {
          issues.add(
            FormatIssue(
              'headers',
              'request.headers.$key',
              'header names must be lower case',
            ),
          );
        } else if (headers[key] is! String) {
          issues.add(
            FormatIssue(
              'headers',
              'request.headers.$key',
              'header values must be strings',
            ),
          );
        }
      }
    }
  }
  if (request.containsKey('body') && request['body'] == null) {
    issues.add(
      const FormatIssue(
        'body',
        'request.body',
        'must not be null (omit the key when there is no body)',
      ),
    );
  }
}

void _validateResponse(List<FormatIssue> issues, Object? response) {
  if (response is! Map<String, dynamic>) {
    issues.add(const FormatIssue('response', 'response', 'must be an object'));
    return;
  }
  _unknownKeys(issues, response, const ['status', 'body'], 'response');
  final status = response['status'];
  if (!_isInteger(status) || (status as num) < 100 || status > 599) {
    issues.add(
      const FormatIssue(
        'status',
        'response.status',
        'must be an integer from 100 to 599',
      ),
    );
  }
  if (response.containsKey('body') && response['body'] == null) {
    issues.add(
      const FormatIssue(
        'body',
        'response.body',
        'must not be null (omit the key when there is no body)',
      ),
    );
  }
}

/// Whether a volatile path matches at least one node of the fixture.
bool _matchesSomething(Object? root, List<String> pattern) {
  bool walk(Object? node, List<String> segments) {
    if (volatileMode([pattern], segments) != null) return true;
    if (node is List) {
      for (var i = 0; i < node.length; i++) {
        if (walk(node[i], [...segments, '$i'])) return true;
      }
      return false;
    }
    if (node is Map<String, dynamic>) {
      return sortedKeys(node).any((key) => walk(node[key], [...segments, key]));
    }
    return false;
  }

  return walk(root, const []);
}

void _validateVolatile(
  List<FormatIssue> issues,
  Map<String, dynamic> fixture,
  List<String> roots,
) {
  final volatile = fixture['volatile'];
  if (volatile is! List) {
    issues.add(
      const FormatIssue('volatile', 'volatile', 'must be an array of strings'),
    );
    return;
  }
  for (var i = 0; i < volatile.length; i++) {
    final entry = volatile[i] as Object?;
    final path = 'volatile.$i';
    if (entry is! String) {
      issues.add(FormatIssue('volatile', path, 'must be a string'));
      continue;
    }
    final segments = entry.split('.');
    if (segments.any((s) => s.isEmpty)) {
      issues.add(
        FormatIssue('volatile', path, 'must not contain empty segments'),
      );
      continue;
    }
    if (segments.sublist(0, segments.length - 1).contains('**')) {
      issues.add(
        FormatIssue('volatile', path, '** is allowed only as the last segment'),
      );
      continue;
    }
    if (!roots.contains(segments.first)) {
      issues.add(
        FormatIssue('volatile', path, 'must start with ${roots.join(' or ')}'),
      );
      continue;
    }
    if (!_matchesSomething(fixture, segments)) {
      issues.add(
        FormatIssue(
          'volatile-unmatched',
          path,
          '$entry matches nothing in this fixture',
        ),
      );
    }
  }
}

/// Checks a decoded fixture against format 1. [name] is the file name without `.json`.
/// Returns an empty list when the fixture is valid.
List<FormatIssue> validateFixtureValue(
  FixtureKind kind,
  String name,
  Object? value,
) {
  if (value is! Map<String, dynamic>) {
    return const [FormatIssue('root', '(root)', 'must be a JSON object')];
  }
  final issues = <FormatIssue>[];
  _unknownKeys(issues, value, _topLevel[kind]!, '');
  if (value['format'] is! num || value['format'] != formatVersion) {
    issues.add(
      const FormatIssue(
        'format',
        'format',
        'must be $formatVersion (this is the only format this version reads)',
      ),
    );
  }
  final fixtureName = value['name'];
  if (fixtureName is! String || !namePattern.hasMatch(fixtureName)) {
    issues.add(
      const FormatIssue(
        'name',
        'name',
        "must be a string of letters, digits, '.', '_' and '-'",
      ),
    );
  } else if (fixtureName != name) {
    issues.add(
      FormatIssue(
        'name',
        'name',
        'must equal the file name without .json ($name)',
      ),
    );
  }
  final description = value['description'];
  if (description is! String || description.isEmpty) {
    issues.add(
      const FormatIssue(
        'description',
        'description',
        'must be a non-empty string',
      ),
    );
  }
  if (kind == FixtureKind.tables) {
    final rows = value['rows'];
    if (rows is! List || rows.isEmpty) {
      issues
          .add(const FormatIssue('rows', 'rows', 'must be a non-empty array'));
    } else {
      for (var i = 0; i < rows.length; i++) {
        final row = rows[i] as Object?;
        if (row is! Map<String, dynamic>) {
          issues.add(
            FormatIssue(
              'rows',
              'rows.$i',
              'must be an object, not ${jsonType(row)}',
            ),
          );
        }
      }
    }
    return issues;
  }
  _validateRequest(issues, value['request']);
  if (kind == FixtureKind.provider) {
    _validateResponse(issues, value['response']);
  }
  if (value.containsKey('volatile')) {
    _validateVolatile(
      issues,
      value,
      kind == FixtureKind.provider
          ? const ['request', 'response']
          : const ['request'],
    );
  }
  return issues;
}

/// Decodes the text of a fixture file and checks it against format 1.
FixtureValidation validateFixture(FixtureKind kind, String name, String text) {
  final Object? value;
  try {
    value = jsonDecode(text);
  } on FormatException {
    return const FixtureValidation(null, [
      FormatIssue('json', '(root)', 'is not valid JSON'),
    ]);
  }
  return FixtureValidation(value, validateFixtureValue(kind, name, value));
}

String formatIssues(Iterable<FormatIssue> issues) =>
    issues.map((i) => '  ${i.path}: ${i.message}').join('\n');
