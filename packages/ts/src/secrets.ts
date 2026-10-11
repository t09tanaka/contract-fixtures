import { isObject, sortedKeys } from "./json.js";

/**
 * The shape of a JSON Web Token: three base64url parts separated by dots, the first of which
 * starts with `eyJ` (a base64url encoded `{"`). The same expression is in spec/format.md and
 * in the Dart package.
 */
export const JWT_PATTERN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

/** Why `path` cannot be a key of `secret`, or `null` when it can. */
export function secretPathProblem(path: string, roots: readonly string[]): string | null {
  const segments = path.split(".");
  if (segments.some((s) => s === "")) return "must not contain empty segments";
  if (segments.includes("**")) return "** is not allowed in a secret path";
  if (segments.some((s) => s.includes("*") && s !== "*")) {
    return "* is allowed only as a whole segment";
  }
  if (!roots.includes(segments[0]!)) return `must start with ${roots.join(" or ")}`;
  if (segments[1] !== "headers" && segments[1] !== "body") {
    return `must continue with headers or body (${segments[0]}.headers.<name>, ${segments[0]}.body...)`;
  }
  return null;
}

/** A node a secret path matches. */
export interface SecretNode {
  /** The path of the node, from the fixture root. */
  segments: string[];
  value: unknown;
  /** Puts another value in the node's place. */
  replace(value: unknown): void;
}

/** The nodes of `root` that `pattern` matches: object keys in code unit order, arrays by index. */
export function secretNodes(root: unknown, pattern: readonly string[]): SecretNode[] {
  const out: SecretNode[] = [];
  const walk = (node: unknown, depth: number, segments: string[]): void => {
    let keys: string[];
    if (Array.isArray(node)) keys = node.map((_item, i) => String(i));
    else if (isObject(node)) keys = sortedKeys(node);
    else return;
    const container = node as Record<string, unknown>;
    for (const key of keys) {
      if (pattern[depth] !== "*" && pattern[depth] !== key) continue;
      const path = [...segments, key];
      if (depth < pattern.length - 1) {
        walk(container[key], depth + 1, path);
        continue;
      }
      out.push({
        segments: path,
        value: container[key],
        replace(value) {
          // Not an assignment: for the key "__proto__" that would not change the property.
          Object.defineProperty(container, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        },
      });
    }
  };
  walk(root, 0, []);
  return out;
}

/**
 * Puts the placeholders of `secret` in place of the values its paths match, in `root` itself.
 * `only` decides which values are replaced: the strings (what verifying does to what a side
 * produced), or everything (used before printing differences). Entries that are not a path
 * and a string are skipped; validation reports them.
 */
export function replaceSecrets(
  root: unknown,
  secret: unknown,
  only: "strings" | "everything",
  skip: (path: string) => boolean = () => false,
): void {
  if (!isObject(secret)) return;
  for (const path of sortedKeys(secret)) {
    const placeholder = secret[path];
    if (skip(path) || typeof placeholder !== "string") continue;
    if (secretPathProblem(path, ["request", "response"]) !== null) continue;
    for (const node of secretNodes(root, path.split("."))) {
      if (only === "everything" || typeof node.value === "string") node.replace(placeholder);
    }
  }
}
