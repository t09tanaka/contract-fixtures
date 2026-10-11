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

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys(value)) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** One-line JSON with sorted keys. Used to print values in differences. */
export function compactJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * The text a fixture file is written as: two-space indentation, trailing newline, keys in the
 * order given, integer-valued numbers without a fraction.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** What `value` looks like after it went over the wire as JSON (drops `undefined`). */
export function jsonRoundTrip(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}
