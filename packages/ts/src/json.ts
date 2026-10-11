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
