import 'json.dart';

enum DifferenceKind { value, type, missing, unexpected, length }

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

enum VolatileMode { exact, subtree }

VolatileMode? _matchPattern(List<String> pattern, List<String> segments) {
  final deep = pattern.last == '**';
  final head = deep ? pattern.sublist(0, pattern.length - 1) : pattern;
  if (segments.length < head.length) return null;
  if (!deep && segments.length != head.length) return null;
  for (var i = 0; i < head.length; i++) {
    if (head[i] != '*' && head[i] != segments[i]) return null;
  }
  return deep ? VolatileMode.subtree : VolatileMode.exact;
}

/// How a node is compared, given the volatile paths. A path without `**` wins.
VolatileMode? volatileMode(List<List<String>> patterns, List<String> segments) {
  VolatileMode? mode;
  for (final pattern in patterns) {
    final match = _matchPattern(pattern, segments);
    if (match == VolatileMode.exact) return VolatileMode.exact;
    if (match == VolatileMode.subtree) mode = VolatileMode.subtree;
  }
  return mode;
}

/// Differences between a stored value and an observed one. Empty when they agree.
///
/// [volatile] lists paths that are compared loosely: a plain path compares the JSON type of
/// that node only; a path ending in `**` compares types, object keys and array lengths of
/// the whole subtree. Everything else must be equal.
List<Difference> differences(
  Object? expected,
  Object? actual, [
  List<String> volatile = const [],
]) {
  final patterns = [for (final path in volatile) path.split('.')];
  final out = <Difference>[];

  void walk(Object? e, Object? a, List<String> segments) {
    final path = segments.isEmpty ? '(root)' : segments.join('.');
    final mode = volatileMode(patterns, segments);
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
                '$path: type $typeE -> $typeA (volatile: only the type is compared)',
              ),
      );
      return;
    }
    if (mode == VolatileMode.exact) return;

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
    if (e is Map<String, dynamic> && a is Map<String, dynamic>) {
      for (final key in sortedKeys({...e, ...a})) {
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
