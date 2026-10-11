import { compactJson, isObject, jsonType, sortedKeys } from "./json.js";

export type DifferenceKind = "value" | "type" | "missing" | "unexpected" | "length";

/** One place where what was observed differs from the stored fixture. */
export interface Difference {
  /** Dot separated path from the root, or `(root)`. */
  path: string;
  kind: DifferenceKind;
  /** One line, stored value first: `response.body.total: 1200 -> 1250`. */
  text: string;
}

type Match = "exact" | "subtree" | null;

function matchPattern(pattern: string[], segments: string[]): Match {
  const deep = pattern[pattern.length - 1] === "**";
  const head = deep ? pattern.slice(0, -1) : pattern;
  if (segments.length < head.length) return null;
  if (!deep && segments.length !== head.length) return null;
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== "*" && head[i] !== segments[i]) return null;
  }
  return deep ? "subtree" : "exact";
}

/** How a node is compared, given the volatile paths. A path without `**` wins. */
export function volatileMode(patterns: string[][], segments: string[]): Match {
  let mode: Match = null;
  for (const pattern of patterns) {
    const match = matchPattern(pattern, segments);
    if (match === "exact") return "exact";
    if (match === "subtree") mode = "subtree";
  }
  return mode;
}

/**
 * Differences between a stored value and an observed one. Empty when they agree.
 *
 * `volatile` lists paths that are compared loosely: a plain path compares the JSON type of
 * that node only; a path ending in `**` compares types, object keys and array lengths of the
 * whole subtree. Everything else must be equal.
 */
export function differences(
  expected: unknown,
  actual: unknown,
  volatile: readonly string[] = [],
): Difference[] {
  const patterns = volatile.map((path) => path.split("."));
  const out: Difference[] = [];

  const walk = (e: unknown, a: unknown, segments: string[]): void => {
    const path = segments.length === 0 ? "(root)" : segments.join(".");
    const mode = volatileMode(patterns, segments);
    const typeE = jsonType(e);
    const typeA = jsonType(a);

    if (typeE !== typeA) {
      out.push(
        mode === null
          ? { path, kind: "value", text: `${path}: ${compactJson(e)} -> ${compactJson(a)}` }
          : {
              path,
              kind: "type",
              text: `${path}: type ${typeE} -> ${typeA} (volatile: only the type is compared)`,
            },
      );
      return;
    }
    if (mode === "exact") return;

    if (Array.isArray(e) && Array.isArray(a)) {
      if (e.length !== a.length) {
        out.push({
          path,
          kind: "length",
          text: `${path}: array length ${e.length} -> ${a.length}`,
        });
        return;
      }
      e.forEach((item, i) => walk(item, a[i], [...segments, String(i)]));
      return;
    }
    if (isObject(e) && isObject(a)) {
      for (const key of sortedKeys({ ...e, ...a })) {
        const child = segments.length === 0 ? key : `${path}.${key}`;
        if (!Object.hasOwn(a, key)) {
          out.push({
            path: child,
            kind: "missing",
            text: `${child}: ${compactJson(e[key])} -> (absent)`,
          });
        } else if (!Object.hasOwn(e, key)) {
          out.push({
            path: child,
            kind: "unexpected",
            text: `${child}: (absent) -> ${compactJson(a[key])}`,
          });
        } else {
          walk(e[key], a[key], [...segments, key]);
        }
      }
      return;
    }
    if (mode === null && e !== a) {
      out.push({ path, kind: "value", text: `${path}: ${compactJson(e)} -> ${compactJson(a)}` });
    }
  };

  walk(expected, actual, []);
  return out;
}

/** The lines of `differences`, indented, one per line. */
export function formatDifferences(diffs: readonly Difference[]): string {
  return diffs.map((d) => `  ${d.text}`).join("\n");
}
