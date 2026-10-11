import { isObject, sortedKeys } from "./json.js";
import { compilePattern, type CompiledPattern } from "./pattern.js";

/**
 * One entry of `volatile`: a path, or a path with the pattern that the string at that path
 * must match as a whole.
 */
export type VolatileEntry = string | { path: string; pattern: string };

/** A volatile entry, taken apart. */
export interface VolatileRule {
  segments: string[];
  /** The position of `**` among the segments, or -1. */
  wildcard: number;
  /** The text of the pattern, or `null` for an entry without one. */
  source: string | null;
  matcher: CompiledPattern | null;
}

/** The path and the pattern of an entry, or `null` when it has neither shape. */
export function entryParts(entry: unknown): { path: string; pattern: string | null } | null {
  if (typeof entry === "string") return { path: entry, pattern: null };
  if (!isObject(entry)) return null;
  const keys = sortedKeys(entry);
  if (keys.length !== 2 || keys[0] !== "path" || keys[1] !== "pattern") return null;
  if (typeof entry.path !== "string" || typeof entry.pattern !== "string") return null;
  return { path: entry.path, pattern: entry.pattern };
}

/** Throws `PatternError` when the pattern of an entry is not one. */
export function volatileRule(path: string, pattern: string | null): VolatileRule {
  const segments = path.split(".");
  return {
    segments,
    wildcard: segments.indexOf("**"),
    source: pattern,
    matcher: pattern === null ? null : compilePattern(pattern),
  };
}

/** The rules of the entries that have the shape of one; validation reports the others. */
export function lenientRules(volatile: unknown): VolatileRule[] {
  if (!Array.isArray(volatile)) return [];
  const rules: VolatileRule[] = [];
  for (const entry of volatile) {
    const parts = entryParts(entry);
    if (parts === null) continue;
    try {
      rules.push(volatileRule(parts.path, parts.pattern));
    } catch {
      // Not a pattern: reported by validation.
    }
  }
  return rules;
}

const fits = (pattern: string | undefined, segment: string | undefined): boolean =>
  pattern === "*" || pattern === segment;

/**
 * How a rule matches the node at `segments`: `exact` (the node itself is volatile), `subtree`
 * (the node is at or below a path that ends in `**`) or `null`.
 */
export function ruleMatch(rule: VolatileRule, segments: readonly string[]): "exact" | "subtree" | null {
  const { segments: pattern, wildcard } = rule;
  if (wildcard === -1) {
    if (segments.length !== pattern.length) return null;
    return pattern.every((p, i) => fits(p, segments[i])) ? "exact" : null;
  }
  const tail = pattern.length - wildcard - 1;
  if (segments.length < wildcard + tail) return null;
  for (let i = 0; i < wildcard; i++) if (!fits(pattern[i], segments[i])) return null;
  for (let i = 1; i <= tail; i++) {
    if (!fits(pattern[pattern.length - i], segments[segments.length - i])) return null;
  }
  return tail === 0 ? "subtree" : "exact";
}

/**
 * How a node is compared, given all rules. A rule that names the node itself wins over a path
 * that ends in `**`; `patterns` are the rules with a pattern among those that name the node.
 */
export function volatileMode(
  rules: readonly VolatileRule[],
  segments: readonly string[],
): { mode: "exact" | "subtree" | null; patterns: VolatileRule[] } {
  let mode: "exact" | "subtree" | null = null;
  const patterns: VolatileRule[] = [];
  for (const rule of rules) {
    const match = ruleMatch(rule, segments);
    if (match === "exact") {
      mode = "exact";
      if (rule.matcher !== null) patterns.push(rule);
    } else if (match === "subtree" && mode === null) mode = "subtree";
  }
  return { mode, patterns };
}

/** The first of `patterns` that `value` does not match as a whole string, or `null`. */
export function failedPattern(patterns: readonly VolatileRule[], value: unknown): VolatileRule | null {
  for (const rule of patterns) {
    if (typeof value !== "string" || !rule.matcher!.test(value)) return rule;
  }
  return null;
}
