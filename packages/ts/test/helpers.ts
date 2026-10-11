import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The shared, language independent cases. Tests run with the package root as the cwd. */
export const SPEC_FIXTURES = path.resolve(process.cwd(), "../../spec/fixtures");

export function loadCases<T>(file: string): T[] {
  const parsed = JSON.parse(fs.readFileSync(path.join(SPEC_FIXTURES, file), "utf8")) as {
    cases: T[];
  };
  return parsed.cases;
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contract-fixtures-"));
}

/** A fresh copy of spec/fixtures/contracts. */
export function copyOfContracts(): string {
  const dir = tempDir();
  fs.cpSync(path.join(SPEC_FIXTURES, "contracts"), dir, { recursive: true });
  return dir;
}

export function writeFile(dir: string, relative: string, text: string): void {
  const file = path.join(dir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function ledgerLines(dir: string, side: string): string[] {
  const file = path.join(dir, ".ledger", `${side}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}

/** Every file below `dir`, the ledger included. */
export function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}
