import 'dart:convert';
import 'dart:io';

import 'configuration.dart';
import 'json.dart';
import 'pattern.dart';
import 'placeholders.dart';
import 'secrets.dart';
import 'types.dart';
import 'volatile.dart';

/// One way in which a file does not follow the fixture format.
class FormatIssue {
  const FormatIssue(this.code, this.path, this.message);

  /// A stable identifier, the same in every implementation: `json`, `root`, `format`,
  /// `name`, `description`, `unknown-key`, `request`, `method`, `path`, `headers`, `body`,
  /// `response`, `status`, `volatile`, `volatile-unmatched`, `volatile-pattern`, `pattern`, `secret`, `secret-unmatched`,
  /// `secret-value`, `secret-volatile`, `jwt`, `forbidden`, `rows` or `number`. One more code is not a
  /// fault of a file: `secret-removed`, when update mode was asked to drop a secret path.
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
final RegExp _upperCase = RegExp('[A-Z]');

const Map<FixtureKind, List<String>> _topLevel = {
  FixtureKind.provider: [
    'format',
    'name',
    'description',
    'request',
    'response',
    'volatile',
    'secret',
  ],
  FixtureKind.consumer: [
    'format',
    'name',
    'description',
    'request',
    'volatile',
    'secret',
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

/// A header value: a string, or a non-empty array of strings (a header sent more than once).
bool _isHeaderValue(Object? value) {
  if (value is String) return true;
  return value is List && value.isNotEmpty && value.every((v) => v is String);
}

void _validateHeaders(
  List<FormatIssue> issues,
  Map<String, dynamic> part,
  String prefix,
) {
  if (!part.containsKey('headers')) return;
  final headers = part['headers'];
  if (headers is! Map<String, dynamic>) {
    issues.add(FormatIssue('headers', '$prefix.headers', 'must be an object'));
    return;
  }
  for (final key in sortedKeys(headers)) {
    if (key.isEmpty || key.contains(_upperCase)) {
      issues.add(
        FormatIssue(
          'headers',
          '$prefix.headers.$key',
          'header names must be non-empty and lower case',
        ),
      );
    } else if (!_isHeaderValue(headers[key])) {
      issues.add(
        FormatIssue(
          'headers',
          '$prefix.headers.$key',
          'header values must be strings or non-empty arrays of strings',
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
  _validateHeaders(issues, request, 'request');
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
  _unknownKeys(
      issues, response, const ['status', 'headers', 'body'], 'response');
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
  _validateHeaders(issues, response, 'response');
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

class _Matched {
  const _Matched(this.segments, this.value);
  final List<String> segments;
  final Object? value;
}

/// The nodes of the fixture that a rule matches, those below a path that ends in `**`
/// included.
List<_Matched> _matchedNodes(Object? root, VolatileRule rule) {
  final out = <_Matched>[];
  void walk(Object? node, List<String> segments) {
    if (rule.match(segments) != null) out.add(_Matched(segments, node));
    if (node is List) {
      for (var i = 0; i < node.length; i++) {
        walk(node[i], [...segments, '$i']);
      }
    } else if (node is Map<String, dynamic>) {
      for (final key in sortedKeys(node)) {
        walk(node[key], [...segments, key]);
      }
    }
  }

  walk(root, const []);
  return out;
}

/// Why [path] cannot be a volatile path, or `null` when it can.
String? _volatilePathProblem(String path, List<String> roots) {
  final segments = path.split('.');
  if (segments.any((s) => s.isEmpty)) return 'must not contain empty segments';
  if (segments.any((s) => s.contains('*') && s != '*' && s != '**')) {
    return '* is allowed only as a whole segment (* or **)';
  }
  if (segments.where((s) => s == '**').length > 1) {
    return '** is allowed only once in a path';
  }
  if (!roots.contains(segments.first)) {
    return 'must start with ${roots.join(' or ')}';
  }
  if (segments.length < 2 || segments[1] == '*' || segments[1] == '**') {
    return 'must name a key of ${segments.first} (a path that covers the whole '
        '${segments.first} would switch the comparison off)';
  }
  return null;
}

void _validateVolatile(
  List<FormatIssue> issues,
  Map<String, dynamic> fixture,
  List<String> roots,
  List<CompiledPattern> forbidden,
) {
  final volatile = fixture['volatile'];
  if (volatile is! List) {
    issues.add(const FormatIssue('volatile', 'volatile', 'must be an array'));
    return;
  }
  // A value is shown, so that a pattern that misses can be corrected, unless it may be a
  // secret: a node that a secret path names, a string of the shape of a token, or one that
  // the configuration of the directory forbids.
  final hidden = <String>{};
  final secret = fixture['secret'];
  if (secret is Map<String, dynamic>) {
    for (final key in sortedKeys(secret)) {
      if (secretPathProblem(key, roots) != null) continue;
      for (final node in secretNodes(fixture, key.split('.'))) {
        hidden.add(node.segments.join('.'));
      }
    }
  }
  String shown(String nodePath, String value) => hidden.contains(nodePath) ||
          jwtPattern.hasMatch(value) ||
          forbidden.any((pattern) => pattern.search(value))
      ? ''
      : '${compactJson(value)} ';
  for (var i = 0; i < volatile.length; i++) {
    final path = 'volatile.$i';
    final parts = entryParts(volatile[i] as Object?);
    if (parts == null) {
      issues.add(
        FormatIssue(
          'volatile',
          path,
          'must be a path, or an object with the keys path and pattern (both '
              'strings) and, optionally, nullable (true)',
        ),
      );
      continue;
    }
    final problem = _volatilePathProblem(parts.path, roots);
    if (problem != null) {
      issues.add(FormatIssue('volatile', path, problem));
      continue;
    }
    if (parts.pattern != null && parts.path.endsWith('.**')) {
      issues.add(
        FormatIssue(
          'volatile',
          path,
          'a path that ends in ** cannot have a pattern (a pattern is for one '
              'string)',
        ),
      );
      continue;
    }
    final VolatileRule rule;
    try {
      rule = VolatileRule(parts);
    } on PatternException catch (error) {
      issues.add(
        FormatIssue(
          'pattern',
          '$path.pattern',
          'is not a pattern this format supports: ${error.message}',
        ),
      );
      continue;
    }
    final nodes = _matchedNodes(fixture, rule);
    if (nodes.isEmpty) {
      issues.add(
        FormatIssue(
          'volatile-unmatched',
          path,
          '${parts.path} matches nothing in this fixture',
        ),
      );
      continue;
    }
    if (rule.matcher == null) continue;
    for (final node in nodes) {
      final value = node.value;
      if (rule.satisfiedBy(value)) continue;
      final nodePath = node.segments.join('.');
      issues.add(
        FormatIssue(
          'volatile-pattern',
          nodePath,
          value is String
              ? '${shown(nodePath, value)}does not match the pattern '
                  '${rule.source} of $path'
              : 'must be a string that matches the pattern ${rule.source} of '
                  "$path${rule.nullable ? ', or null' : ''} "
                  '(found ${jsonType(value)})',
        ),
      );
    }
  }
}

/// Whole numbers beyond 2^53 - 1 do not survive every JSON parser, so they are not allowed.
void _validateNumbers(List<FormatIssue> issues, Object? root) {
  void walk(Object? node, String path) {
    if (isUnsafeNumber(node)) {
      issues.add(
        FormatIssue(
          'number',
          path,
          'is a whole number beyond 2^53 - 1 or not finite, which not every JSON '
              'parser keeps exact (use a string)',
        ),
      );
    } else if (node is List) {
      for (var i = 0; i < node.length; i++) {
        walk(node[i], '$path.$i');
      }
    } else if (node is Map<String, dynamic>) {
      for (final key in sortedKeys(node)) {
        walk(node[key], path.isEmpty ? key : '$path.$key');
      }
    }
  }

  walk(root, '');
}

void _validateSecret(
  List<FormatIssue> issues,
  Map<String, dynamic> fixture,
  List<String> roots,
) {
  final secret = fixture['secret'];
  if (secret is! Map<String, dynamic>) {
    issues.add(
      const FormatIssue(
        'secret',
        'secret',
        'must be an object of paths and placeholders',
      ),
    );
    return;
  }
  final volatile = lenientRules(fixture['volatile']);
  for (final key in sortedKeys(secret)) {
    final path = 'secret.$key';
    final problem = secretPathProblem(key, roots);
    if (problem != null) {
      issues.add(FormatIssue('secret', path, problem));
      continue;
    }
    final placeholder = secret[key];
    if (placeholder is! String || parsePlaceholder(placeholder) == null) {
      issues.add(
        FormatIssue(
          'secret',
          path,
          'must be a placeholder such as <token:customer-1>',
        ),
      );
      continue;
    }
    final nodes = secretNodes(fixture, key.split('.'));
    if (nodes.isEmpty) {
      issues.add(
        FormatIssue(
          'secret-unmatched',
          path,
          '$key matches nothing in this fixture',
        ),
      );
      continue;
    }
    for (final node in nodes) {
      final value = node.value;
      if (value == placeholder) continue;
      // The value itself is never printed: it may be the secret.
      final found = value is String ? 'another string' : jsonType(value);
      issues.add(
        FormatIssue(
          'secret-value',
          node.segments.join('.'),
          'is listed in secret, so it must be a string that is stored as '
              '$placeholder (found $found)',
        ),
      );
    }
    if (nodes
        .any((node) => volatileMode(volatile, node.segments).mode != null)) {
      issues.add(
        FormatIssue(
          'secret-volatile',
          path,
          '$key is also covered by volatile (a placeholder does not change '
              'between runs)',
        ),
      );
    }
  }
}

/// A token that was not replaced by a placeholder must not be written or stay stored.
void _validateNoJwt(List<FormatIssue> issues, Object? root) {
  void walk(Object? node, String path) {
    if (node is String) {
      if (jwtPattern.hasMatch(node)) {
        issues.add(
          FormatIssue(
            'jwt',
            path,
            'contains what looks like a JSON Web Token (list this path in secret, '
                'so that a placeholder is stored instead)',
          ),
        );
      }
    } else if (node is List) {
      for (var i = 0; i < node.length; i++) {
        walk(node[i], '$path.$i');
      }
    } else if (node is Map<String, dynamic>) {
      for (final key in sortedKeys(node)) {
        walk(node[key], path.isEmpty ? key : '$path.$key');
      }
    }
  }

  walk(root, '');
}

/// A string that the configuration of the directory forbids must not be written or stay
/// stored.
void _validateNotForbidden(
  List<FormatIssue> issues,
  Object? root,
  List<CompiledPattern> forbidden,
) {
  if (forbidden.isEmpty) return;
  void walk(Object? node, String path) {
    if (node is String) {
      for (var i = 0; i < forbidden.length; i++) {
        if (!forbidden[i].search(node)) continue;
        // The value itself is never printed: it may be the secret.
        issues.add(
          FormatIssue(
            'forbidden',
            path,
            'contains what forbidden.$i of config.json describes '
                '(list this path in secret, so that a placeholder is stored instead)',
          ),
        );
      }
    } else if (node is List) {
      for (var i = 0; i < node.length; i++) {
        walk(node[i], '$path.$i');
      }
    } else if (node is Map<String, dynamic>) {
      for (final key in sortedKeys(node)) {
        walk(node[key], path.isEmpty ? key : '$path.$key');
      }
    }
  }

  walk(root, '');
}

/// Checks a decoded fixture against format 1. [name] is the file name without `.json`.
/// [config] is what the `config.json` of the contracts directory says (see `readConfig`).
/// Returns an empty list when the fixture is valid.
List<FormatIssue> validateFixtureValue(
  FixtureKind kind,
  String name,
  Object? value, [
  ContractsConfig config = const ContractsConfig(),
]) {
  if (value is! Map<String, dynamic>) {
    return const [FormatIssue('root', '(root)', 'must be a JSON object')];
  }
  final forbidden = config.forbidden.map(compilePattern).toList();
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
    _validateNumbers(issues, value);
    return issues;
  }
  _validateRequest(issues, value['request']);
  if (kind == FixtureKind.provider) {
    _validateResponse(issues, value['response']);
  }
  final roots = kind == FixtureKind.provider
      ? const ['request', 'response']
      : const ['request'];
  if (value.containsKey('volatile')) {
    _validateVolatile(issues, value, roots, forbidden);
  }
  if (value.containsKey('secret')) _validateSecret(issues, value, roots);
  _validateNumbers(issues, value);
  _validateNoJwt(issues, value);
  _validateNotForbidden(issues, value, forbidden);
  return issues;
}

/// Decodes the text of a fixture file and checks it against format 1.
FixtureValidation validateFixture(
  FixtureKind kind,
  String name,
  String text, [
  ContractsConfig config = const ContractsConfig(),
]) {
  final Object? value;
  try {
    value = jsonDecode(text.startsWith('\uFEFF') ? text.substring(1) : text);
  } on FormatException {
    return const FixtureValidation(null, [
      FormatIssue('json', '(root)', 'is not valid JSON'),
    ]);
  }
  return FixtureValidation(
    value,
    validateFixtureValue(kind, name, value, config),
  );
}

/// Reads a fixture file and checks it against format 1. The file must be UTF-8 (a byte
/// order mark is ignored); anything else is reported as the `json` issue.
FixtureValidation validateFixtureFile(
  FixtureKind kind,
  String name,
  File file, [
  ContractsConfig config = const ContractsConfig(),
]) {
  final String text;
  try {
    text = utf8.decode(file.readAsBytesSync());
  } on FormatException {
    return const FixtureValidation(null, [
      FormatIssue('json', '(root)', 'is not valid UTF-8'),
    ]);
  }
  return validateFixture(kind, name, text, config);
}

String formatIssues(Iterable<FormatIssue> issues) =>
    issues.map((i) => '  ${i.path}: ${i.message}').join('\n');
