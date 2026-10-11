import 'json.dart';

/// The shape of a JSON Web Token: three base64url parts separated by dots, the first of
/// which starts with `eyJ` (a base64url encoded `{"`). The same expression is in
/// spec/format.md and in the TypeScript package.
final RegExp jwtPattern = RegExp(
  r'(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',
);

/// Why [path] cannot be a key of `secret`, or `null` when it can.
String? secretPathProblem(String path, List<String> roots) {
  final segments = path.split('.');
  if (segments.any((s) => s.isEmpty)) return 'must not contain empty segments';
  if (segments.contains('**')) return '** is not allowed in a secret path';
  if (segments.any((s) => s.contains('*') && s != '*')) {
    return '* is allowed only as a whole segment';
  }
  if (!roots.contains(segments.first)) {
    return 'must start with ${roots.join(' or ')}';
  }
  if (segments.length < 2 ||
      (segments[1] != 'headers' && segments[1] != 'body')) {
    return 'must continue with headers or body (${segments.first}.headers.<name>, '
        '${segments.first}.body...)';
  }
  return null;
}

/// A node a secret path matches.
class SecretNode {
  SecretNode(this.segments, this.value, this.replace);

  /// The path of the node, from the fixture root.
  final List<String> segments;
  final Object? value;

  /// Puts another value in the node's place.
  final void Function(Object? value) replace;
}

/// The nodes of [root] that [pattern] matches: object keys in code unit order, arrays by
/// index.
List<SecretNode> secretNodes(Object? root, List<String> pattern) {
  final out = <SecretNode>[];
  void walk(Object? node, int depth, List<String> segments) {
    void visit(String key, Object? child, void Function(Object?) replace) {
      if (pattern[depth] != '*' && pattern[depth] != key) return;
      final path = [...segments, key];
      if (depth < pattern.length - 1) {
        walk(child, depth + 1, path);
      } else {
        out.add(SecretNode(path, child, replace));
      }
    }

    if (node is List) {
      for (var i = 0; i < node.length; i++) {
        visit('$i', node[i], (value) => node[i] = value);
      }
    } else if (node is Map<String, dynamic>) {
      for (final key in sortedKeys(node)) {
        visit(key, node[key], (value) => node[key] = value);
      }
    }
  }

  walk(root, 0, const []);
  return out;
}

/// Puts the placeholders of [secret] in place of the values its paths match, in [root]
/// itself. By default only strings are replaced (what verifying does to what a side
/// produced); with [everything], whatever is there (used before printing differences).
/// Entries that are not a path and a string are skipped; validation reports them.
void replaceSecrets(
  Object? root,
  Object? secret, {
  bool everything = false,
  bool Function(String path)? skip,
}) {
  if (secret is! Map<String, dynamic>) return;
  for (final path in sortedKeys(secret)) {
    final placeholder = secret[path];
    if ((skip != null && skip(path)) || placeholder is! String) continue;
    if (secretPathProblem(path, const ['request', 'response']) != null) {
      continue;
    }
    for (final node in secretNodes(root, path.split('.'))) {
      if (everything || node.value is String) node.replace(placeholder);
    }
  }
}
