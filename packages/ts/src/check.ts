import fs from "node:fs";
import path from "node:path";

import { readLedger, type LedgerAction } from "./ledger.js";
import { KINDS, type Kind, type Side } from "./types.js";
import { validateFixture } from "./validate.js";

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
}

/** What one side has to do with each kind of fixture. */
export function requiredAction(side: Side, kind: Kind): LedgerAction {
  return kind === side ? "verified" : "read";
}

/** Names (file names without `.json`) of the fixtures of one kind, sorted. */
export function listFixtureNames(dir: string, kind: Kind): string[] {
  const kindDir = path.join(dir, kind);
  if (!fs.existsSync(kindDir)) return [];
  return fs
    .readdirSync(kindDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
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
  let fixtures = 0;

  for (const kind of KINDS) {
    for (const name of listFixtureNames(dir, kind)) {
      fixtures++;
      const file = `${kind}/${name}.json`;
      const text = fs.readFileSync(path.join(dir, kind, `${name}.json`), "utf8");
      const { issues } = validateFixture(kind, name, text);
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
      if (!done.has(`${action}:${file}`)) {
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
  return { side, fixtures, problems };
}

/** The report the `check` command prints. */
export function formatCheckResult(result: CheckResult): string {
  const head = `contract-fixtures check (${result.side} side)`;
  if (result.problems.length === 0) {
    return `${head}: ${result.fixtures} fixture(s), all verified or read by this side's tests.`;
  }
  const lines = result.problems.map((p) => `  - ${p.file === "" ? "" : `${p.file}: `}${p.message}`);
  return [
    `${head}: ${result.problems.length} problem(s) in ${result.fixtures} fixture(s)`,
    ...lines,
    `Run \`contract-fixtures reset\` and the ${result.side} side's tests before this check.`,
  ].join("\n");
}
