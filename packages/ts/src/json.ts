export type JsonType = "null" | "boolean" | "number" | "string" | "array" | "object";

export function jsonType(value: unknown): JsonType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return type;
  return "object";
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Object keys in UTF-16 code unit order (the same order in every implementation). */
export function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * One-line JSON with keys in code unit order. Used to print values in differences.
 * Written by hand because a JavaScript object cannot hold its keys in that order: keys that
 * are array indexes always come first.
 */
export function compactJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compactJson).join(",")}]`;
  if (isObject(value)) {
    const members = sortedKeys(value)
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${compactJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The most code units of a value that a difference or an issue prints. */
export const MAX_SHOWN_LENGTH = 200;

/**
 * `compactJson`, cut after `MAX_SHOWN_LENGTH` code units (one less when that would split a
 * surrogate pair) and followed by `... (<n> more)`, n being the code units left out. A line
 * of a difference stays readable that way; the whole value is in the fixture file.
 */
export function shownJson(value: unknown): string {
  return cutText(compactJson(value));
}

function cutText(text: string): string {
  if (text.length <= MAX_SHOWN_LENGTH) return text;
  const last = text.charCodeAt(MAX_SHOWN_LENGTH - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? MAX_SHOWN_LENGTH - 1 : MAX_SHOWN_LENGTH;
  return `${text.slice(0, cut)}... (${text.length - cut} more)`;
}

/** How much of what two long values have in common is kept before the place where they part. */
const SHOWN_CONTEXT = 20;

/**
 * The two sides of a difference, as `shownJson` prints them. When both are longer than
 * `MAX_SHOWN_LENGTH` and equal that far, cutting each would print the same text twice; both
 * then start `SHOWN_CONTEXT` code units before the first one that differs, after
 * `(<n> the same) ... `, n being the code units left out at the start.
 */
export function shownPair(stored: unknown, observed: unknown): [string, string] {
  const s = compactJson(stored);
  const o = compactJson(observed);
  let same = 0;
  while (same < s.length && same < o.length && s.charCodeAt(same) === o.charCodeAt(same)) same++;
  if (s.length <= MAX_SHOWN_LENGTH || o.length <= MAX_SHOWN_LENGTH || same < MAX_SHOWN_LENGTH) {
    return [cutText(s), cutText(o)];
  }
  let skip = same - SHOWN_CONTEXT;
  const first = s.charCodeAt(skip);
  if (first >= 0xdc00 && first <= 0xdfff) skip--;
  const lead = `(${skip} the same) ... `;
  return [lead + cutText(s.slice(skip)), lead + cutText(o.slice(skip))];
}

/**
 * The text a fixture file is written as: two-space indentation, trailing newline,
 * integer-valued numbers without a fraction. Keys keep the order given, except that keys that
 * are array indexes come first in ascending order (what JavaScript does to every object).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Thrown by `jsonRoundTrip` for a value JSON has no form for. */
export class NotJsonError extends Error {}

/**
 * What `value` looks like after it went over the wire as JSON (drops `undefined`).
 * NaN and Infinity are refused: `JSON.stringify` would silently turn them into `null`.
 */
export function jsonRoundTrip(value: unknown): unknown {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new NotJsonError();
    return item;
  });
  return text === undefined ? undefined : JSON.parse(text);
}

/** The largest integer every implementation represents exactly (2^53 - 1). */
export const MAX_SAFE_INTEGER = 9007199254740991;

/** Whether a number is one that not every implementation can represent exactly. */
export function isUnsafeNumber(value: unknown): boolean {
  if (typeof value !== "number") return false;
  return !Number.isFinite(value) || (Number.isInteger(value) && Math.abs(value) > MAX_SAFE_INTEGER);
}

/** Lower-cases A to Z only, so every implementation gives the same result. */
export function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
