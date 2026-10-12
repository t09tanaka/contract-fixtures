import { isObject, jsonType, shownJson, sortedKeys } from "./json.js";
import {
  entryParts,
  failedPattern,
  requirement,
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

  const walk = (e: unknown, a: unknown, segments: string[]): void => {
    const path = segments.length === 0 ? "(root)" : segments.join(".");
    const { mode, patterns } = volatileMode(rules, segments);
    const typeE = jsonType(e);
    const typeA = jsonType(a);

    if (mode === "exact" && patterns.length > 0) {
      // The stored value follows its entries (validation saw to that), so only the observed
      // one is asked. With `nullable`, a string and null may stand in for each other.
      const failed = failedPattern(patterns, a);
      if (failed !== null) {
        out.push(
          typeE === typeA || typeof a === "string"
            ? {
                path,
                kind: "pattern",
                text: `${path}: ${shownJson(e)} -> ${shownJson(a)} (volatile: does not match ${failed.source})`,
              }
            : { path, kind: "type", text: `${path}: type ${typeE} -> ${typeA} (volatile: ${requirement(failed)})` },
        );
      } else if (typeE !== typeA && failedPattern(patterns, e) !== null) {
        const rule = failedPattern(patterns, e)!;
        out.push({ path, kind: "type", text: `${path}: type ${typeE} -> ${typeA} (volatile: ${requirement(rule)})` });
      }
      return;
    }
    if (typeE !== typeA) {
      out.push(
        mode === null
          ? { path, kind: "value", text: `${path}: ${shownJson(e)} -> ${shownJson(a)}` }
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
            text: `${child}: ${shownJson(e[key])} -> (absent)`,
          });
        } else if (!Object.hasOwn(e, key)) {
          out.push({
            path: child,
            kind: "unexpected",
            text: `${child}: (absent) -> ${shownJson(a[key])}`,
          });
        } else {
          walk(e[key], a[key], [...segments, key]);
        }
      }
      return;
    }
    if (mode === null && e !== a) {
      out.push({ path, kind: "value", text: `${path}: ${shownJson(e)} -> ${shownJson(a)}` });
    }
  };

  walk(expected, actual, []);
  // The status of a response says most about what happened, and the lines before it can be
  // long: it comes first. Everything else keeps the order of the walk.
  const first = (d: Difference): boolean => d.path === "response.status";
  return [...out.filter(first), ...out.filter((d) => !first(d))];
}

/** The lines of `differences`, indented, one per line. */
export function formatDifferences(diffs: readonly Difference[]): string {
  return diffs.map((d) => `  ${d.text}`).join("\n");
}
