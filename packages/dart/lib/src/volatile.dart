import 'pattern.dart';

/// An entry of `volatile` with a pattern: the string at [path] changes between runs, but it
/// always matches [pattern] as a whole. Pass it to `verifyResponse` / `verifyRequest` next
/// to plain paths: `volatile: ['response.body.note', VolatilePattern('response.body.id',
/// r'^ord_[a-z0-9]+$')]`.
class VolatilePattern {
  const VolatilePattern(this.path, this.pattern);

  final String path;

  /// A pattern in the syntax of spec/format.md (a subset of ECMAScript regular expressions).
  final String pattern;

  Map<String, dynamic> toJson() => {'path': path, 'pattern': pattern};
}

/// The path and the pattern of an entry.
class EntryParts {
  const EntryParts(this.path, this.pattern);

  final String path;
  final String? pattern;
}

/// The parts of a decoded entry, or `null` when it has neither shape.
EntryParts? entryParts(Object? entry) {
  if (entry is String) return EntryParts(entry, null);
  if (entry is! Map<String, dynamic> || entry.length != 2) return null;
  final path = entry['path'];
  final pattern = entry['pattern'];
  if (path is! String || pattern is! String) return null;
  return EntryParts(path, pattern);
}

enum VolatileMode { exact, subtree }

/// A volatile entry, taken apart.
class VolatileRule {
  /// Throws [PatternException] when [source] is not a pattern.
  VolatileRule(String path, this.source)
      : segments = path.split('.'),
        matcher = source == null ? null : compilePattern(source) {
    wildcard = segments.indexOf('**');
  }

  final List<String> segments;

  /// The position of `**` among the segments, or -1.
  late final int wildcard;

  /// The text of the pattern, or `null` for an entry without one.
  final String? source;
  final CompiledPattern? matcher;

  static bool _fits(String pattern, String segment) =>
      pattern == '*' || pattern == segment;

  /// How this rule matches the node at [path]: [VolatileMode.exact] (the node itself is
  /// volatile), [VolatileMode.subtree] (the node is at or below a path that ends in `**`)
  /// or `null`.
  VolatileMode? match(List<String> path) {
    if (wildcard == -1) {
      if (path.length != segments.length) return null;
      for (var i = 0; i < segments.length; i++) {
        if (!_fits(segments[i], path[i])) return null;
      }
      return VolatileMode.exact;
    }
    final tail = segments.length - wildcard - 1;
    if (path.length < wildcard + tail) return null;
    for (var i = 0; i < wildcard; i++) {
      if (!_fits(segments[i], path[i])) return null;
    }
    for (var i = 1; i <= tail; i++) {
      if (!_fits(segments[segments.length - i], path[path.length - i])) {
        return null;
      }
    }
    return tail == 0 ? VolatileMode.subtree : VolatileMode.exact;
  }
}

/// The rules of the entries that have the shape of one; validation reports the others.
List<VolatileRule> lenientRules(Object? volatile) {
  final rules = <VolatileRule>[];
  if (volatile is! List) return rules;
  for (final entry in volatile) {
    final parts = entryParts(entry);
    if (parts == null) continue;
    try {
      rules.add(VolatileRule(parts.path, parts.pattern));
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

/// A rule that names the node itself wins over a path that ends in `**`.
VolatileMatch volatileMode(List<VolatileRule> rules, List<String> segments) {
  VolatileMode? mode;
  final patterns = <VolatileRule>[];
  for (final rule in rules) {
    final match = rule.match(segments);
    if (match == VolatileMode.exact) {
      mode = VolatileMode.exact;
      if (rule.matcher != null) patterns.add(rule);
    } else if (match == VolatileMode.subtree && mode == null) {
      mode = VolatileMode.subtree;
    }
  }
  return VolatileMatch(mode, patterns);
}

/// The first of [patterns] that [value] does not match as a whole string, or `null`.
VolatileRule? failedPattern(List<VolatileRule> patterns, Object? value) {
  for (final rule in patterns) {
    if (value is! String || !rule.matcher!.test(value)) return rule;
  }
  return null;
}
