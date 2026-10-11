import fs from "node:fs";
import path from "node:path";

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

export function appendLedger(dir: string, side: Side, action: LedgerAction, kind: Kind, name: string): void {
  const file = ledgerPath(dir, side);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry: LedgerEntry = { side, action, file: `${kind}/${name}.json` };
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

/** Forgets what earlier test runs of one side did. Run it before that side's tests. */
export function resetLedger(options: { dir: string; side: Side }): void {
  fs.rmSync(ledgerPath(options.dir, options.side), { force: true });
}

/** The entries of one side's ledger, and the line numbers that could not be parsed. */
export function readLedger(dir: string, side: Side): { entries: LedgerEntry[]; badLines: number[] } {
  const file = ledgerPath(dir, side);
  const entries: LedgerEntry[] = [];
  const badLines: number[] = [];
  if (!fs.existsSync(file)) return { entries, badLines };
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.trim() === "") return;
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
  return { entries, badLines };
}
