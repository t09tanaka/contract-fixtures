import { isObject, sortedKeys } from "./json.js";
import { compilePattern, type CompiledPattern } from "./pattern.js";

/**
 * One entry of `volatile`: a path, or a path with the pattern that the string at that path
 * must match as a whole. With `nullable: true` the value may also be `null`.
 */
export type VolatileEntry = string | { path: string; pattern: string; nullable?: true };

/** A volatile entry, taken apart. */
export interface VolatileRule {
  segments: string[];
  /** The position of `**` among the segments, or -1. */
  wildcard: number;
  /** The text of the pattern, or `null` for an entry without one. */
  source: string | null;
  matcher: CompiledPattern | null;
  /** Whether `null` is accepted in the place of a string that matches the pattern. */
  nullable: boolean;
}

/** The parts of an entry. */
export interface EntryParts {
  path: string;
  pattern: string | null;
  nullable: boolean;
}

/**
 * The parts of an entry, or `null` when it has neither shape: a path, or an object with the
 * keys `path` and `pattern` (both strings) and, optionally, `nullable` (only `true`).
 */
export function entryParts(entry: unknown): EntryParts | null {
  if (typeof entry === "string") return { path: entry, pattern: null, nullable: false };
  if (!isObject(entry)) return null;
  const keys = sortedKeys(entry);
  if (keys.some((key) => key !== "path" && key !== "pattern" && key !== "nullable")) return null;
  if (typeof entry.path !== "string" || typeof entry.pattern !== "string") return null;
  if (Object.hasOwn(entry, "nullable") && entry.nullable !== true) return null;
  return { path: entry.path, pattern: entry.pattern, nullable: entry.nullable === true };
}

/** Throws `PatternError` when the pattern of an entry is not one. */
export function volatileRule(parts: EntryParts): VolatileRule {
  const segments = parts.path.split(".");
  return {
    segments,
    wildcard: segments.indexOf("**"),
    source: parts.pattern,
    matcher: parts.pattern === null ? null : compilePattern(parts.pattern),
    nullable: parts.nullable,
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
      rules.push(volatileRule(parts));
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
  // From the end: the last segments tell most nodes apart, the first ones hardly any.
  if (wildcard === -1) {
    if (segments.length !== pattern.length) return null;
    for (let i = pattern.length - 1; i >= 0; i--) if (!fits(pattern[i], segments[i])) return null;
    return "exact";
  }
  const tail = pattern.length - wildcard - 1;
  if (segments.length < wildcard + tail) return null;
  for (let i = 1; i <= tail; i++) {
    if (!fits(pattern[pattern.length - i], segments[segments.length - i])) return null;
  }
  for (let i = wildcard - 1; i >= 0; i--) if (!fits(pattern[i], segments[i])) return null;
  return tail === 0 ? "subtree" : "exact";
}

const NO_PATTERNS: VolatileRule[] = [];
const UNNAMED: { mode: "exact" | "subtree" | null; patterns: VolatileRule[] } = Object.freeze({
  mode: null,
  patterns: NO_PATTERNS,
});

/**
 * How a node is compared, given all rules. A rule that names the node itself wins over a path
 * that ends in `**`; `patterns` are the rules with a pattern among those that name the node.
 */
export function volatileMode(
  rules: readonly VolatileRule[],
  segments: readonly string[],
): { mode: "exact" | "subtree" | null; patterns: VolatileRule[] } {
  let mode: "exact" | "subtree" | null = null;
  let patterns: VolatileRule[] | null = null;
  for (const rule of rules) {
    const match = ruleMatch(rule, segments);
    if (match === "exact") {
      mode = "exact";
      if (rule.matcher !== null) (patterns ??= []).push(rule);
    } else if (match === "subtree" && mode === null) mode = "subtree";
  }
  // Most nodes are named by no entry: nothing is made for them.
  if (mode === null) return UNNAMED;
  return { mode, patterns: patterns ?? NO_PATTERNS };
}

/**
 * For a depth, the rules that can match a node that deep, in the order of the entries: a
 * rule without `**` only matches nodes as deep as it is long, so most rules need not be
 * asked at most nodes. The answer for a depth is worked out once.
 */
export function rulesByDepth<Rule extends VolatileRule>(rules: readonly Rule[]): (depth: number) => readonly Rule[] {
  const known = new Map<number, Rule[]>();
  return (depth) => {
    let at = known.get(depth);
    if (at === undefined) {
      at = rules.filter((rule) =>
        rule.wildcard === -1 ? rule.segments.length === depth : rule.segments.length - 1 <= depth,
      );
      known.set(depth, at);
    }
    return at;
  };
}

/** Whether `value` is what a rule with a pattern asks for: a matching string, or `null` if nullable. */
export function satisfies(rule: VolatileRule, value: unknown): boolean {
  if (value === null) return rule.nullable;
  return typeof value === "string" && rule.matcher!.test(value);
}

/** The first of `patterns` that `value` does not satisfy, or `null`. */
export function failedPattern(patterns: readonly VolatileRule[], value: unknown): VolatileRule | null {
  for (const rule of patterns) {
    if (!satisfies(rule, value)) return rule;
  }
  return null;
}

/** What a rule with a pattern asks for, as the text of a difference or an issue. */
export function requirement(rule: VolatileRule): string {
  return `must be a string that matches ${rule.source}${rule.nullable ? ", or null" : ""}`;
}
