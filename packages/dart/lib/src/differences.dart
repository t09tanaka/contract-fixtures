import 'json.dart';
import 'volatile.dart';

enum DifferenceKind { value, type, pattern, missing, unexpected, length }

/// One place where what was observed differs from the stored fixture.
class Difference {
  const Difference(this.path, this.kind, this.text);

  /// Dot separated path from the root, or `(root)`.
  final String path;
  final DifferenceKind kind;

  /// One line, stored value first: `response.body.total: 1200 -> 1250`.
  final String text;

  @override
  String toString() => text;
}

/// Differences between a stored value and an observed one. Empty when they agree.
///
/// [volatile] lists paths that are compared loosely: a plain path compares the JSON type of
/// that node only; a path ending in `**` compares types, object keys and array lengths of
/// the whole subtree; an entry with a pattern ([VolatilePattern], or a decoded
/// `{path, pattern}`) requires a string that matches the pattern as a whole. Everything else
/// must be equal. Throws for an entry that is not one.
List<Difference> differences(
  Object? expected,
  Object? actual, [
  List<Object?> volatile = const [],
]) {
  final rules = [
    for (final entry in volatile)
      switch (entryParts(
        entry is VolatilePattern ? entry.toJson() : entry,
      )) {
        null => throw ArgumentError.value(
            entry,
            'volatile',
            'a volatile entry is a path or {path, pattern}',
          ),
        final parts => VolatileRule(parts.path, parts.pattern),
      },
  ];
  final out = <Difference>[];

  void walk(Object? e, Object? a, List<String> segments) {
    final path = segments.isEmpty ? '(root)' : segments.join('.');
    final VolatileMatch(:mode, :patterns) = volatileMode(rules, segments);
    final typeE = jsonType(e);
    final typeA = jsonType(a);

    if (typeE != typeA) {
      out.add(
        mode == null
            ? Difference(
                path,
                DifferenceKind.value,
                '$path: ${compactJson(e)} -> ${compactJson(a)}',
              )
            : Difference(
                path,
                DifferenceKind.type,
                '$path: type $typeE -> $typeA ${patterns.isNotEmpty ? '(volatile: must be a string that matches ${patterns.first.source})' : '(volatile: only the type is compared)'}',
              ),
      );
      return;
    }
    if (mode == VolatileMode.exact) {
      final failed = failedPattern(patterns, a);
      if (failed != null) {
        out.add(
          Difference(
            path,
            DifferenceKind.pattern,
            '$path: ${compactJson(e)} -> ${compactJson(a)} '
            '(volatile: does not match ${failed.source})',
          ),
        );
      }
      return;
    }

    if (e is List && a is List) {
      if (e.length != a.length) {
        out.add(
          Difference(
            path,
            DifferenceKind.length,
            '$path: array length ${e.length} -> ${a.length}',
          ),
        );
        return;
      }
      for (var i = 0; i < e.length; i++) {
        walk(e[i], a[i], [...segments, '$i']);
      }
      return;
    }
    if (e is Map && a is Map) {
      for (final key in sortedKeys({
        ...e.cast<String, dynamic>(),
        ...a.cast<String, dynamic>(),
      })) {
        final child = segments.isEmpty ? key : '$path.$key';
        if (!a.containsKey(key)) {
          out.add(
            Difference(
              child,
              DifferenceKind.missing,
              '$child: ${compactJson(e[key])} -> (absent)',
            ),
          );
        } else if (!e.containsKey(key)) {
          out.add(
            Difference(
              child,
              DifferenceKind.unexpected,
              '$child: (absent) -> ${compactJson(a[key])}',
            ),
          );
        } else {
          walk(e[key], a[key], [...segments, key]);
        }
      }
      return;
    }
    if (mode == null && e != a) {
      out.add(
        Difference(
          path,
          DifferenceKind.value,
          '$path: ${compactJson(e)} -> ${compactJson(a)}',
        ),
      );
    }
  }

  walk(expected, actual, const []);
  return out;
}

/// The lines of [diffs], indented, one per line.
String formatDifferences(Iterable<Difference> diffs) =>
    diffs.map((d) => '  ${d.text}').join('\n');
