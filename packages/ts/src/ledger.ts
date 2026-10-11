import fs from "node:fs";
import path from "node:path";

import { ContractUsageError } from "./errors.js";
import type { Kind, Side } from "./types.js";

export type LedgerAction = "verified" | "read";

export interface LedgerEntry {
  side: Side;
  action: LedgerAction;
  /** `<kind>/<name>.json`, with `/` on every platform. */
  file: string;
}

export function ledgerPath(dir: string, side: Side): string {
  return path.join(dir, ".ledger", `${side}.jsonl`);
}

/**
 * What is at the path of a ledger: a file, nothing, or something that cannot be one (a
 * directory, or a path that cannot be looked at).
 */
function ledgerKind(file: string): "file" | "absent" | "other" {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat === undefined ? "absent" : stat.isFile() ? "file" : "other";
  } catch (error) {
    // A file in the place of the directory `.ledger`: there is no ledger below it.
    return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? "absent" : "other";
  }
}

/**
 * Runs one operation on a ledger. Whatever goes wrong with the file is reported in the same
 * words by every implementation, and never passed over.
 */
function onLedger<T>(side: Side, file: string, operation: (kind: "file" | "absent") => T): T {
  const kind = ledgerKind(file);
  if (kind !== "other") {
    try {
      return operation(kind);
    } catch {
      // reported below
    }
  }
  throw new ContractUsageError(
    `contract-fixtures: the ledger .ledger/${side}.jsonl cannot be used ` +
      "(it is not a file, or it cannot be read or written)",
  );
}

export function appendLedger(dir: string, side: Side, action: LedgerAction, kind: Kind, name: string): void {
  const file = ledgerPath(dir, side);
  const entry: LedgerEntry = { side, action, file: `${kind}/${name}.json` };
  onLedger(side, file, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  });
}

/**
 * Forgets what earlier test runs of one side did. Run it before that side's tests. Throws
 * `ContractUsageError` when the ledger cannot be removed.
 */
export function resetLedger(options: { dir: string; side: Side }): void {
  const file = ledgerPath(options.dir, options.side);
  onLedger(options.side, file, (kind) => {
    if (kind === "file") fs.rmSync(file);
  });
}

/**
 * The entries of one side's ledger, the line numbers that could not be parsed, and whether
 * the file exists at all. Throws `ContractUsageError` when it is there and cannot be read.
 */
export function readLedger(
  dir: string,
  side: Side,
): { entries: LedgerEntry[]; badLines: number[]; exists: boolean } {
  const file = ledgerPath(dir, side);
  const entries: LedgerEntry[] = [];
  const badLines: number[] = [];
  const text = onLedger(side, file, (kind) => (kind === "file" ? fs.readFileSync(file, "utf8") : null));
  if (text === null) return { entries, badLines, exists: false };
  // A byte order mark is not a part of the first line. A line is blank when it holds nothing
  // but spaces, tabs and carriage returns (the same in every implementation).
  text
    .replace(/^\uFEFF/, "")
    .split("\n")
    .forEach((line, i) => {
      if (/^[ \t\r]*$/.test(line)) return;
      try {
        const entry = JSON.parse(line) as Partial<LedgerEntry> | null;
        if (
          entry !== null &&
          typeof entry === "object" &&
          entry.side === side &&
          (entry.action === "verified" || entry.action === "read") &&
          typeof entry.file === "string"
        ) {
          entries.push({ side, action: entry.action, file: entry.file });
          return;
        }
      } catch {
        // fall through
      }
      badLines.push(i + 1);
    });
  return { entries, badLines, exists: true };
}
