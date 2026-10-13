import fs from "node:fs";
import path from "node:path";

import {
  CONFIG_FILE,
  declaredReaders,
  entryNames,
  readConfig,
  readerTakes,
  requireDeclaredReader,
} from "./configuration.js";
import { ledgerName, readLedger, type LedgerAction } from "./ledger.js";
import { KINDS, SIDES, type Kind, type Side } from "./types.js";
import { validateFixtureFile } from "./validate.js";

export interface CheckProblem {
  /** `<kind>/<name>.json`, `config.json`, `.ledger/<side>.jsonl`, or `""` for the directory as a whole. */
  file: string;
  code: "invalid" | "unverified" | "unread" | "unclaimed" | "ledger" | "empty";
  message: string;
}

export interface CheckResult {
  side: Side;
  /** The reader that was checked, when the consumer side has more than one. */
  reader?: string;
  /** Number of fixture files found (with a reader: of those the reader verifies or reads). */
  fixtures: number;
  problems: CheckProblem[];
  /**
   * What the state of the ledger suggests about the cause of `unverified` and `unread`
   * problems. Guesses, worded as such; they never change `problems`.
   */
  hints: string[];
  /**
   * Whether this side's ledger has no entries, so that none of the fixtures that follow the
   * format was verified or read. The report then gives their number instead of one line each.
   */
  untouched: boolean;
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
  if (!(fs.statSync(kindDir, { throwIfNoEntry: false })?.isDirectory() ?? false)) return [];
  return fs
    .readdirSync(kindDir)
    .filter((file) => file.endsWith(".json") && isFile(path.join(kindDir, file)))
    .map((file) => file.slice(0, -".json".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Compares the fixtures on disk with one side's ledger: every fixture must follow the format,
 * and this side's tests must have verified or read each of them since the last reset. With
 * `reader`, the fixtures are those that reader verifies or reads, and the ledger is its own.
 */
export function checkContracts(options: { dir: string; side: Side; reader?: string }): CheckResult {
  const { dir, side, reader } = options;
  const problems: CheckProblem[] = [];
  const ledgerFile = ledgerName(side, reader);
  // A configuration that is not valid is a problem of its own; the fixtures are then
  // checked as if there were none.
  const { config, issues: configIssues } = readConfig(dir);
  if (side === "consumer") requireDeclaredReader(config, reader);
  const ledger = readLedger(dir, side, reader);
  const done = new Set(ledger.entries.map((e) => `${e.action}:${e.file}`));
  let fixtures = 0;
  let asked = 0;
  let missing = 0;
  for (const issue of configIssues) {
    problems.push({
      file: CONFIG_FILE,
      code: "invalid",
      message: `invalid configuration: ${issue.path} ${issue.message}`,
    });
  }
  // An entry of a reader that names nothing exempts nothing, and is most likely a name that
  // was mistyped or a fixture that is gone. The provider side looks at every reader.
  const readers = declaredReaders(config);
  const names = Object.fromEntries(KINDS.map((kind) => [kind, listFixtureNames(dir, kind)])) as Record<Kind, string[]>;
  for (const declared of readers.filter((r) => side === "provider" || r === reader)) {
    for (const kind of ["provider", "tables"] as const) {
      (config.readers[declared]![kind] ?? []).forEach((entry, i) => {
        if (names[kind].some((fixture) => entryNames(entry, fixture))) return;
        problems.push({
          file: CONFIG_FILE,
          code: "invalid",
          message: `invalid configuration: readers.${declared}.${kind}.${i} names no fixture in ${kind}/ (${entry})`,
        });
      });
    }
  }

  const onDisk = new Set(KINDS.flatMap((kind) => names[kind].map((fixture) => `${kind}/${fixture}.json`)));

  for (const kind of KINDS) {
    for (const name of names[kind]) {
      if (!readerTakes(config, reader, kind, name)) continue;
      fixtures++;
      const file = `${kind}/${name}.json`;
      const { issues } = validateFixtureFile(kind, name, path.join(dir, kind, `${name}.json`), config);
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
  // With readers, no check of a reader asks for a fixture that none of them takes. The
  // provider side sees the whole directory, so it is the one to say so.
  if (side === "provider" && readers.length > 0) {
    for (const kind of KINDS) {
      for (const name of names[kind]) {
        if (readers.some((r) => readerTakes(config, r, kind, name))) continue;
        problems.push({
          file: `${kind}/${name}.json`,
          code: "unclaimed",
          message:
            kind === "consumer"
              ? `verified by no reader of ${CONFIG_FILE} (the name of a consumer fixture starts with the name of its reader and a dot)`
              : `read by no reader of ${CONFIG_FILE} (list it for a reader under readers, or delete it)`,
        });
      }
    }
  }
  for (const line of ledger.badLines) {
    problems.push({
      file: `.ledger/${ledgerFile}.jsonl`,
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
    ledger: `.ledger/${ledgerFile}.jsonl`,
    other,
    asked,
    missing,
    ledgerExists: ledger.exists,
    lines: ledger.entries.length,
    otherLines: missing > 0 ? otherEntries(dir, other) : 0,
    gone: new Set(ledger.entries.map((e) => e.file).filter((file) => !onDisk.has(file))).size,
  });
  return {
    side,
    ...(reader === undefined ? {} : { reader }),
    fixtures,
    problems,
    hints,
    untouched: ledger.entries.length === 0 && asked > 0,
  };
}

/** The entries in the other side's ledger: only a hint depends on them, so a ledger that cannot be read has none. */
function otherEntries(dir: string, other: Side): number {
  try {
    return readLedger(dir, other).entries.length;
  } catch {
    return 0;
  }
}

/**
 * Hints for a check with `unverified` or `unread` problems, from what the ledger looks like.
 * At most two. The wording is pinned by spec/fixtures/check.json for every implementation.
 */
function checkHints(state: {
  side: Side;
  /** The ledger of the side, as the report names it. */
  ledger: string;
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
  const { side, ledger, other, asked, missing, lines, gone } = state;
  if (missing === 0) return [];
  const hints: string[] = [];
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
  const head = `${TOOL} check (${result.side} side${result.reader === undefined ? "" : `, reader ${result.reader}`})`;
  if (result.problems.length === 0) {
    return `${head}: OK (${result.fixtures} fixture(s), all verified or read by this side's tests)`;
  }
  const untouched = (p: CheckProblem): boolean =>
    result.untouched && (p.code === "unverified" || p.code === "unread");
  const count = result.problems.filter(untouched).length;
  const lines = result.problems
    // One line in the place of the first of them, when all were left alone.
    .filter((p, i) => !untouched(p) || result.problems.findIndex(untouched) === i)
    .map((p) =>
      untouched(p)
        ? `  - none of the ${count} fixture(s) that follow the format was verified or read by the ` +
          `${result.side} side's tests (they are not listed one by one)`
        : `  - ${p.file === "" ? "" : `${p.file}: `}${p.message}`,
    );
  return [
    `${head}: ${result.problems.length} problem(s) in ${result.fixtures} fixture(s)`,
    ...lines,
    ...result.hints.map((hint) => `Hint: ${hint}`),
    result.reader === undefined
      ? `Run \`${TOOL} reset\` and the ${result.side} side's tests before this check.`
      : `Run \`${TOOL} reset --side consumer --reader ${result.reader}\` and the tests of that reader before this check.`,
  ].join("\n");
}
