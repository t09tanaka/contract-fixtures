import path from "node:path";

import { listFixtureNames } from "./check.js";
import { readConfig } from "./configuration.js";
import { ContractUsageError } from "./errors.js";
import { compactJson, isObject, jsonType, sortedKeys } from "./json.js";
import { KINDS, type Kind } from "./types.js";
import { validateFixtureFile } from "./validate.js";

/** One fixture, as the `summary` command prints it. */
export interface FixtureSummary {
  kind: Kind;
  name: string;
  /** Whether the file follows the format. The other members are `null` or `"-"` when not. */
  valid: boolean;
  /** `null` for a table. */
  method: string | null;
  path: string | null;
  /** `null` for a consumer fixture and a table. */
  status: number | null;
  /**
   * The response body: `{error: string, available: number}` with the keys in code unit order
   * (objects inside it are opened up to the depth asked for), `array(3)`, the type of a
   * scalar, or `-` without a body. For a table, the number of rows.
   */
  body: string;
}

const PLAIN_KEY = /^[A-Za-z0-9_.-]+$/;

/** The keys of an object with the JSON type of each value; objects are opened `depth` levels deep. */
function members(value: Record<string, unknown>, depth: number): string {
  const parts = sortedKeys(value).map((key) => {
    const child = value[key];
    const type = depth > 1 && isObject(child) ? members(child, depth - 1) : jsonType(child);
    return `${PLAIN_KEY.test(key) ? key : compactJson(key)}: ${type}`;
  });
  return `{${parts.join(", ")}}`;
}

/** A body: its keys with the JSON type of each value, `depth` levels deep. */
function shape(body: unknown, depth: number): string {
  if (body === undefined) return "-";
  if (Array.isArray(body)) return `array(${body.length})`;
  if (!isObject(body)) return jsonType(body);
  return members(body, depth);
}

/** The deepest level the summary opens. */
export const MAX_SUMMARY_DEPTH = 9;

/**
 * Every fixture of a contracts directory in one row each, to read them side by side: which
 * status an exchange has, and which keys its response body has. With `depth` 2 (or more, up to
 * 9) the objects inside the body are opened as well. Reads the files only; the ledger is
 * neither read nor written.
 */
export function summarizeContracts(options: { dir: string; depth?: number }): FixtureSummary[] {
  const depth = options.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_SUMMARY_DEPTH) {
    throw new ContractUsageError(`contract-fixtures: depth must be a whole number from 1 to ${MAX_SUMMARY_DEPTH}`);
  }
  const rows: FixtureSummary[] = [];
  const { config } = readConfig(options.dir);
  for (const kind of KINDS) {
    for (const name of listFixtureNames(options.dir, kind)) {
      const file = path.join(options.dir, kind, `${name}.json`);
      const { value, issues } = validateFixtureFile(kind, name, file, config);
      if (issues.length > 0) {
        rows.push({ kind, name, valid: false, method: null, path: null, status: null, body: "-" });
        continue;
      }
      if (kind === "tables") {
        const count = (value as { rows: unknown[] }).rows.length;
        rows.push({ kind, name, valid: true, method: null, path: null, status: null, body: `${count} row(s)` });
        continue;
      }
      const fixture = value as {
        request: { method: string; path: string };
        response?: { status: number; body?: unknown };
      };
      rows.push({
        kind,
        name,
        valid: true,
        method: fixture.request.method,
        path: fixture.request.path,
        status: fixture.response?.status ?? null,
        body: shape(fixture.response?.body, depth),
      });
    }
  }
  return rows;
}

/**
 * The text the `summary` command prints: a header and one line per fixture, in columns that
 * are padded with spaces (counted in UTF-16 code units, so every implementation prints the
 * same text).
 */
export function formatSummary(rows: readonly FixtureSummary[]): string {
  const cells = [
    ["FIXTURE", "REQUEST", "STATUS", "RESPONSE BODY"],
    ...rows.map((row) => [
      `${row.kind}/${row.name}`,
      row.method === null ? "-" : `${row.method} ${row.path}`,
      row.status === null ? "-" : String(row.status),
      row.valid ? row.body : "(does not follow the format; see check)",
    ]),
  ];
  const widths = [0, 1, 2].map((column) => Math.max(...cells.map((line) => line[column]!.length)));
  return cells
    .map((line) => line.map((cell, column) => (column < 3 ? cell.padEnd(widths[column]!) : cell)).join("  "))
    .join("\n");
}
