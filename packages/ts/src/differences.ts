import { isObject, jsonType, shownJson, shownPair, sortedKeys } from "./json.js";
import {
  entryParts,
  failedPattern,
  requirement,
  rulesByDepth,
  volatileMode,
  volatileRule,
  type VolatileEntry,
} from "./volatile.js";

export type DifferenceKind = "value" | "type" | "pattern" | "missing" | "unexpected" | "length";

/** One place where what was observed differs from the stored fixture. */
export interface Difference {
  /** Dot separated path from the root, or `(root)`. */
  path: string;
  kind: DifferenceKind;
  /** One line, stored value first: `response.body.total: 1200 -> 1250`. */
  text: string;
}

/**
 * Differences between a stored value and an observed one. Empty when they agree.
 *
 * `volatile` lists paths that are compared loosely: a plain path compares the JSON type of
 * that node only; a path ending in `**` compares types, object keys and array lengths of the
 * whole subtree; an entry `{ path, pattern }` requires a string that matches the pattern as a
 * whole (or `null`, with `nullable: true`). Everything else must be equal. Throws for an entry
 * that is not one.
 */
export function differences(
  expected: unknown,
  actual: unknown,
  volatile: readonly VolatileEntry[] = [],
): Difference[] {
  const rules = volatile.map((entry) => {
    const parts = entryParts(entry);
    if (parts === null) throw new TypeError("a volatile entry is a path or { path, pattern, nullable }");
    return volatileRule(parts);
  });
  const out: Difference[] = [];
  const candidates = rulesByDepth(rules);
  // One list of segments for the whole walk, and a path only where a line is printed: most
  // nodes are equal, and a text for each of them is most of the work on a large body.
  const segments: string[] = [];
  const where = (): string => (segments.length === 0 ? "(root)" : segments.join("."));

  const walk = (e: unknown, a: unknown): void => {
    const { mode, patterns } = volatileMode(candidates(segments.length), segments);
    const typeE = jsonType(e);
    const typeA = jsonType(a);

    if (mode === "exact" && patterns.length > 0) {
      // The stored value follows its entries (validation saw to that), so only the observed
      // one is asked. With `nullable`, a string and null may stand in for each other.
      const failed = failedPattern(patterns, a);
      if (failed !== null) {
        const path = where();
        out.push(
          typeE === typeA || typeof a === "string"
            ? {
                path,
                kind: "pattern",
                text: `${path}: ${shownPair(e, a).join(" -> ")} (volatile: does not match ${failed.source})`,
              }
            : { path, kind: "type", text: `${path}: type ${typeE} -> ${typeA} (volatile: ${requirement(failed)})` },
        );
      } else if (typeE !== typeA && failedPattern(patterns, e) !== null) {
        const rule = failedPattern(patterns, e)!;
        const path = where();
        out.push({ path, kind: "type", text: `${path}: type ${typeE} -> ${typeA} (volatile: ${requirement(rule)})` });
      }
      return;
    }
    if (typeE !== typeA) {
      const path = where();
      out.push(
        mode === null
          ? { path, kind: "value", text: `${path}: ${shownPair(e, a).join(" -> ")}` }
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
        const path = where();
        out.push({
          path,
          kind: "length",
          text: `${path}: array length ${e.length} -> ${a.length}`,
        });
        return;
      }
      for (let i = 0; i < e.length; i++) {
        segments.push(String(i));
        walk(e[i], a[i]);
        segments.pop();
      }
      return;
    }
    if (isObject(e) && isObject(a)) {
      for (const key of unionOfKeys(e, a)) {
        if (!Object.hasOwn(a, key)) {
          const child = segments.length === 0 ? key : `${where()}.${key}`;
          out.push({
            path: child,
            kind: "missing",
            text: `${child}: ${shownJson(e[key])} -> (absent)`,
          });
        } else if (!Object.hasOwn(e, key)) {
          const child = segments.length === 0 ? key : `${where()}.${key}`;
          out.push({
            path: child,
            kind: "unexpected",
            text: `${child}: (absent) -> ${shownJson(a[key])}`,
          });
        } else {
          segments.push(key);
          walk(e[key], a[key]);
          segments.pop();
        }
      }
      return;
    }
    if (mode === null && e !== a) {
      const path = where();
      out.push({ path, kind: "value", text: `${path}: ${shownPair(e, a).join(" -> ")}` });
    }
  };

  walk(expected, actual);
  // The status of a response says most about what happened, and the lines before it can be
  // long: it comes first. Everything else keeps the order of the walk.
  const first = (d: Difference): boolean => d.path === "response.status";
  return [...out.filter(first), ...out.filter((d) => !first(d))];
}

/** The keys of both objects in code unit order; those of one, when the other has the same. */
function unionOfKeys(e: Record<string, unknown>, a: Record<string, unknown>): string[] {
  const keys = sortedKeys(e);
  let same = Object.keys(a).length === keys.length;
  for (let i = 0; same && i < keys.length; i++) same = Object.hasOwn(a, keys[i]!);
  return same ? keys : sortedKeys({ ...e, ...a });
}

/** The lines of `differences`, indented, one per line. */
export function formatDifferences(diffs: readonly Difference[]): string {
  return diffs.map((d) => `  ${d.text}`).join("\n");
}
