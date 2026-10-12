import 'pattern.dart';

/// An entry of `volatile` with a pattern: the string at [path] changes between runs, but it
/// always matches [pattern] as a whole. Pass it to `verifyResponse` / `verifyRequest` next
/// to plain paths: `volatile: ['response.body.note', VolatilePattern('response.body.id',
/// r'^ord_[a-z0-9]+$')]`.
///
/// With [nullable], the value may also be `null`: for a date that is only there once
/// something was closed, say.
class VolatilePattern {
  const VolatilePattern(this.path, this.pattern, {this.nullable = false});

  final String path;

  /// A pattern in the syntax of spec/format.md (a subset of ECMAScript regular expressions).
  final String pattern;

  /// Whether `null` is accepted in the place of a string that matches [pattern].
  final bool nullable;

  Map<String, dynamic> toJson() => {
        'path': path,
        'pattern': pattern,
        if (nullable) 'nullable': true,
      };
}

/// The parts of an entry.
class EntryParts {
  const EntryParts(this.path, this.pattern, {this.nullable = false});

  final String path;
  final String? pattern;
  final bool nullable;
}

/// The parts of a decoded entry, or `null` when it has neither shape: a path, or a map with
/// the keys `path` and `pattern` (both strings) and, optionally, `nullable` (only `true`).
EntryParts? entryParts(Object? entry) {
  if (entry is String) return EntryParts(entry, null);
  if (entry is! Map<String, dynamic>) return null;
  if (entry.keys
      .any((key) => !const ['path', 'pattern', 'nullable'].contains(key))) {
    return null;
  }
  final path = entry['path'];
  final pattern = entry['pattern'];
  if (path is! String || pattern is! String) return null;
  if (entry.containsKey('nullable') && entry['nullable'] != true) return null;
  return EntryParts(path, pattern, nullable: entry['nullable'] == true);
}

enum VolatileMode { exact, subtree }

/// A volatile entry, taken apart.
class VolatileRule {
  /// Throws [PatternException] when the pattern of [parts] is not one.
  VolatileRule(EntryParts parts)
      : segments = parts.path.split('.'),
        source = parts.pattern,
        nullable = parts.nullable,
        matcher =
            parts.pattern == null ? null : compilePattern(parts.pattern!) {
    wildcard = segments.indexOf('**');
  }

  final List<String> segments;

  /// The position of `**` among the segments, or -1.
  late final int wildcard;

  /// The text of the pattern, or `null` for an entry without one.
  final String? source;
  final CompiledPattern? matcher;

  /// Whether `null` is accepted in the place of a string that matches the pattern.
  final bool nullable;

  /// Whether [value] is what this rule (one with a pattern) asks for: a matching string, or
  /// `null` if nullable.
  bool satisfiedBy(Object? value) {
    if (value == null) return nullable;
    return value is String && matcher!.test(value);
  }

  /// What this rule (one with a pattern) asks for, as the text of a difference.
  String get requirement =>
      'must be a string that matches $source${nullable ? ', or null' : ''}';

  static bool _fits(String pattern, String segment) =>
      pattern == '*' || pattern == segment;

  /// How this rule matches the node at [path]: [VolatileMode.exact] (the node itself is
  /// volatile), [VolatileMode.subtree] (the node is at or below a path that ends in `**`)
  /// or `null`.
  VolatileMode? match(List<String> path) {
    // From the end: the last segments tell most nodes apart, the first ones hardly any.
    if (wildcard == -1) {
      if (path.length != segments.length) return null;
      for (var i = segments.length - 1; i >= 0; i--) {
        if (!_fits(segments[i], path[i])) return null;
      }
      return VolatileMode.exact;
    }
    final tail = segments.length - wildcard - 1;
    if (path.length < wildcard + tail) return null;
    for (var i = 1; i <= tail; i++) {
      if (!_fits(segments[segments.length - i], path[path.length - i])) {
        return null;
      }
    }
    for (var i = wildcard - 1; i >= 0; i--) {
      if (!_fits(segments[i], path[i])) return null;
    }
    return tail == 0 ? VolatileMode.subtree : VolatileMode.exact;
  }
}

/// For a depth, the rules that can match a node that deep, in the order of the entries: a
/// rule without `**` only matches nodes as deep as it is long, so most rules need not be
/// asked at most nodes. The answer for a depth is worked out once.
List<Rule> Function(int depth) rulesByDepth<Rule extends VolatileRule>(
  List<Rule> rules,
) {
  final known = <int, List<Rule>>{};
  return (depth) => known[depth] ??= [
        for (final rule in rules)
          if (rule.wildcard == -1
              ? rule.segments.length == depth
              : rule.segments.length - 1 <= depth)
            rule,
      ];
}

/// The rules of the entries that have the shape of one; validation reports the others.
List<VolatileRule> lenientRules(Object? volatile) {
  final rules = <VolatileRule>[];
  if (volatile is! List) return rules;
  for (final entry in volatile) {
    final parts = entryParts(entry);
    if (parts == null) continue;
    try {
      rules.add(VolatileRule(parts));
    } on PatternException {
      // Not a pattern: reported by validation.
    }
  }
  return rules;
}

/// How a node is compared, given all rules.
class VolatileMatch {
  const VolatileMatch(this.mode, this.patterns);

  final VolatileMode? mode;

  /// The rules with a pattern among those that name the node itself.
  final List<VolatileRule> patterns;
}

const VolatileMatch _unnamed = VolatileMatch(null, []);

/// A rule that names the node itself wins over a path that ends in `**`.
VolatileMatch volatileMode(List<VolatileRule> rules, List<String> segments) {
  VolatileMode? mode;
  List<VolatileRule>? patterns;
  for (final rule in rules) {
    final match = rule.match(segments);
    if (match == VolatileMode.exact) {
      mode = VolatileMode.exact;
      if (rule.matcher != null) (patterns ??= []).add(rule);
    } else if (match == VolatileMode.subtree && mode == null) {
      mode = VolatileMode.subtree;
    }
  }
  // Most nodes are named by no entry: nothing is made for them.
  if (mode == null) return _unnamed;
  return VolatileMatch(mode, patterns ?? const []);
}

/// The first of [patterns] that [value] does not satisfy, or `null`.
VolatileRule? failedPattern(List<VolatileRule> patterns, Object? value) {
  for (final rule in patterns) {
    if (!rule.satisfiedBy(value)) return rule;
  }
  return null;
}
