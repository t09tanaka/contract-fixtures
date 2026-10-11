final RegExp _placeholder = RegExp(r'^<([a-z][a-z0-9-]*):([A-Za-z0-9._-]+)>$');

/// A secret placeholder such as `<token:customer-1>`.
class Placeholder {
  const Placeholder(this.kind, this.name);

  final String kind;
  final String name;
}

/// Parses `<kind:name>`; `null` when the string is not a placeholder.
Placeholder? parsePlaceholder(String value) {
  final match = _placeholder.firstMatch(value);
  if (match == null) return null;
  return Placeholder(match.group(1)!, match.group(2)!);
}

/// Returns a copy of a JSON value in which every string that is a secret placeholder
/// (`<kind:name>`, for example `<token:customer-1>`) is replaced by what [resolve] returns.
///
/// A `Map<String, String>` or `List<String>` keeps its type; every other map or list in the
/// result is a `Map<String, dynamic>` or `List<dynamic>`, as `jsonDecode` would build it.
///
/// Throws when [resolve] returns `null`, so an unknown placeholder never reaches the code
/// under test as a literal.
T resolvePlaceholders<T>(
  T value,
  String? Function(String kind, String name) resolve,
) {
  Object? walk(Object? node) {
    if (node is String) {
      final placeholder = parsePlaceholder(node);
      if (placeholder == null) return node;
      final resolved = resolve(placeholder.kind, placeholder.name);
      if (resolved == null) {
        throw StateError(
            'contract_fixtures: no value for the placeholder $node');
      }
      return resolved;
    }
    if (node is List<String>) {
      return <String>[for (final item in node) walk(item) as String];
    }
    if (node is List) return [for (final item in node) walk(item)];
    if (node is Map<String, String>) {
      return <String, String>{
        for (final entry in node.entries)
          entry.key: walk(entry.value) as String,
      };
    }
    if (node is Map) {
      return <String, dynamic>{
        for (final entry in node.entries)
          entry.key as String: walk(entry.value),
      };
    }
    return node;
  }

  return walk(value) as T;
}
