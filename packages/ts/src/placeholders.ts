const PLACEHOLDER = /^<([a-z][a-z0-9-]*):([A-Za-z0-9._-]+)>$/;

/** Parses `<kind:name>`; `null` when the string is not a placeholder. */
export function parsePlaceholder(value: string): { kind: string; name: string } | null {
  const match = PLACEHOLDER.exec(value);
  return match ? { kind: match[1]!, name: match[2]! } : null;
}

/**
 * Returns a copy of a JSON value in which every string that is a secret placeholder
 * (`<kind:name>`, for example `<token:customer-1>`) is replaced by what `resolve` returns.
 * Throws when `resolve` returns `undefined`, so an unknown placeholder never reaches the code
 * under test as a literal.
 */
export function resolvePlaceholders<T>(
  value: T,
  resolve: (kind: string, name: string) => string | undefined,
): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const placeholder = parsePlaceholder(node);
      if (!placeholder) return node;
      const resolved = resolve(placeholder.kind, placeholder.name);
      if (resolved === undefined) {
        throw new Error(`contract-fixtures: no value for the placeholder ${node}`);
      }
      return resolved;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return node;
  };
  return walk(value) as T;
}
