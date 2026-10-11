import fs from "node:fs";
import path from "node:path";

import { readLedger, type LedgerAction } from "./ledger.js";
import { KINDS, SIDES, type Kind, type Side } from "./types.js";
import { validateFixtureFile } from "./validate.js";

export interface CheckProblem {
  /** `<kind>/<name>.json`, `.ledger/<side>.jsonl`, or `""` for the directory as a whole. */
  file: string;
  code: "invalid" | "unverified" | "unread" | "ledger" | "empty";
  message: string;
}

export interface CheckResult {
  side: Side;
  /** Number of fixture files found. */
  fixtures: number;
  problems: CheckProblem[];
  /**
   * What the state of the ledger suggests about the cause of `unverified` and `unread`
   * problems. Guesses, worded as such; they never change `problems`.
   */
  hints: string[];
}

/** What one side has to do with each kind of fixture. */
export function requiredAction(side: Side, kind: Kind): LedgerAction {
  return kind === side ? "verified" : "read";
}

/** Whether a path is a file, following symbolic links (a dangling link is not). */
function isFile(filePath: string): boolean {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Names (file names without `.json`) of the fixtures of one kind, sorted. */
export function listFixtureNames(dir: string, kind: Kind): string[] {
  const kindDir = path.join(dir, kind);
  if (!fs.existsSync(kindDir)) return [];
  return fs
    .readdirSync(kindDir)
    .filter((file) => file.endsWith(".json") && isFile(path.join(kindDir, file)))
    .map((file) => file.slice(0, -".json".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Compares the fixtures on disk with one side's ledger: every fixture must follow the format,
 * and this side's tests must have verified or read each of them since the last reset.
 */
export function checkContracts(options: { dir: string; side: Side }): CheckResult {
  const { dir, side } = options;
  const problems: CheckProblem[] = [];
  const ledger = readLedger(dir, side);
  const done = new Set(ledger.entries.map((e) => `${e.action}:${e.file}`));
  const onDisk = new Set<string>();
  let fixtures = 0;
  let asked = 0;
  let missing = 0;

  for (const kind of KINDS) {
    for (const name of listFixtureNames(dir, kind)) {
      fixtures++;
      const file = `${kind}/${name}.json`;
      onDisk.add(file);
      const { issues } = validateFixtureFile(kind, name, path.join(dir, kind, `${name}.json`));
      if (issues.length > 0) {
        for (const issue of issues) {
          problems.push({
            file,
            code: "invalid",
            message: `invalid fixture: ${issue.path} ${issue.message}`,
          });
        }
        continue;
      }
      const action = requiredAction(side, kind);
      asked++;
      if (!done.has(`${action}:${file}`)) {
        missing++;
        problems.push(
          action === "verified"
            ? {
                file,
                code: "unverified",
                message:
                  `not verified by the ${side} side's tests ` +
                  "(stale: delete it, or restore the test that produces it)",
              }
            : {
                file,
                code: "unread",
                message:
                  `not read by the ${side} side's tests ` +
                  "(add a test that feeds it to the real code)",
              },
        );
      }
    }
  }
  for (const line of ledger.badLines) {
    problems.push({
      file: `.ledger/${side}.jsonl`,
      code: "ledger",
      message: `line ${line} is not a ledger entry of the ${side} side`,
    });
  }
  if (fixtures === 0) {
    problems.push({
      file: "",
      code: "empty",
      message: "no fixtures found under provider/, consumer/ or tables/ (wrong directory?)",
    });
  }
  const other = SIDES.find((s) => s !== side)!;
  const hints = checkHints({
    side,
    other,
    asked,
    missing,
    ledgerExists: ledger.exists,
    lines: ledger.entries.length,
    otherLines: missing > 0 ? readLedger(dir, other).entries.length : 0,
    gone: new Set(ledger.entries.map((e) => e.file).filter((file) => !onDisk.has(file))).size,
  });
  return { side, fixtures, problems, hints };
}

/**
 * Hints for a check with `unverified` or `unread` problems, from what the ledger looks like.
 * At most two. The wording is pinned by spec/fixtures/check.json for every implementation.
 */
function checkHints(state: {
  side: Side;
  other: Side;
  /** Fixtures that follow the format: each needs one verify or read of this side. */
  asked: number;
  /** How many of those have none. */
  missing: number;
  ledgerExists: boolean;
  /** Entries in this side's ledger, and in the other side's. */
  lines: number;
  otherLines: number;
  /** Files this side's ledger names that are not in the directory. */
  gone: number;
}): string[] {
  const { side, other, asked, missing, lines, gone } = state;
  if (missing === 0) return [];
  const hints: string[] = [];
  const ledger = `.ledger/${side}.jsonl`;
  if (lines === 0) {
    const what = state.ledgerExists ? `${ledger} has no entries` : `${ledger} does not exist`;
    hints.push(
      state.otherLines > 0
        ? `${what}, but .ledger/${other}.jsonl has some. ` +
          `Did the ${side} side's tests run, and is ${side} the side to check?`
        : `${what}. Did the ${side} side's tests run, and do they use this contracts directory?`,
    );
  } else if (missing === asked) {
    hints.push(
      `${ledger} has ${lines} entr${lines === 1 ? "y" : "ies"}, but none that this check asks for. ` +
        `Did the ${side} side's tests run since the fixtures changed?`,
    );
  } else if (missing * 2 > asked) {
    hints.push(
      `Only ${asked - missing} of the ${asked} fixtures that follow the format were verified or read. If a part of the tests ran ` +
        "(a filter, one shard of several), run all of them, or join the ledgers of all shards, " +
        "before this check.",
    );
  }
  if (gone > 0) {
    hints.push(
      `${ledger} names ${gone} file(s) that are not in this directory. ` +
        "It may be left from an earlier run: run the reset before the tests.",
    );
  }
  return hints;
}

/** The name of the executable, the first word of what the commands print. */
export const TOOL = "contract-fixtures";

/** The report the `check` command prints. */
export function formatCheckResult(result: CheckResult): string {
  const head = `${TOOL} check (${result.side} side)`;
  if (result.problems.length === 0) {
    return `${head}: OK (${result.fixtures} fixture(s), all verified or read by this side's tests)`;
  }
  const lines = result.problems.map((p) => `  - ${p.file === "" ? "" : `${p.file}: `}${p.message}`);
  return [
    `${head}: ${result.problems.length} problem(s) in ${result.fixtures} fixture(s)`,
    ...lines,
    ...result.hints.map((hint) => `Hint: ${hint}`),
    `Run \`${TOOL} reset\` and the ${result.side} side's tests before this check.`,
  ].join("\n");
}
