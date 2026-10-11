import fs from "node:fs";
import path from "node:path";

import { checkContracts, formatCheckResult, TOOL } from "./check.js";
import { DIR_ENV } from "./contract.js";
import { resetLedger } from "./ledger.js";
import { formatSummary, summarizeContracts } from "./summary.js";
import type { Side } from "./types.js";
import { VERSION } from "./version.js";

/** The text printed for `--help` and after a usage error. */
export const USAGE = `${TOOL} — shared request/response fixtures that keep an API and its clients in step

Usage: ${TOOL} <reset|check> --side <provider|consumer> [--dir <contracts>]
       ${TOOL} summary [--dir <contracts>]

Commands:
  reset    Forget what earlier test runs of this side did. Run it before the tests.
  check    Fail unless this side's tests verified or read every fixture since the reset,
           and every fixture follows the format. Run it after all tests of this side.
  summary  Print one line per fixture: request, status, and the keys of the response body
           with their types. Does not touch the ledger.

Options:
  --side <provider|consumer>  The side whose tests ran. Not for summary
  --dir <contracts>           The contracts directory: the one that holds provider/, consumer/
                              and tables/, not the directory of a package
                              (default: the environment variable ${DIR_ENV})
  -h, --help                  Show this help
  -v, --version               Show the version

Exit codes: 0 no problems, 1 problems found (summary: no fixtures), 2 wrong usage`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
}

/** Runs the command line and returns the exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const usage = (message: string): number => {
    io.err(`${TOOL}: ${message}\n\n${USAGE}`);
    return 2;
  };
  let command: string | undefined;
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      io.out(USAGE);
      return 0;
    }
    if (arg === "--version" || arg === "-v") {
      io.out(VERSION);
      return 0;
    }
    const option = /^--(side|dir)(?:=(.*))?$/s.exec(arg);
    if (option) {
      const value = option[2] ?? argv[++i];
      if (value === undefined) return usage(`--${option[1]} needs a value`);
      values[option[1]!] = value;
    } else if (arg.startsWith("-")) {
      return usage(`unknown option: ${arg}`);
    } else if (command === undefined) {
      command = arg;
    } else {
      return usage(`unexpected argument: ${arg}`);
    }
  }
  if (command === undefined) return usage("no command given");
  if (command !== "check" && command !== "reset" && command !== "summary") {
    return usage(`unknown command: ${command}`);
  }
  const side = values.side;
  if (command === "summary") {
    if (side !== undefined) return usage("summary takes no --side");
  } else if (side !== "provider" && side !== "consumer") {
    return usage("--side must be provider or consumer");
  }
  const given = values.dir ?? io.env[DIR_ENV];
  if (given === undefined || given === "") return usage(`pass --dir or set ${DIR_ENV}`);
  const dir = path.resolve(given);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return usage(`${given} is not a directory`);
  }

  if (command === "summary") {
    const rows = summarizeContracts({ dir });
    if (rows.length === 0) {
      io.err(`${TOOL} summary: no fixtures found under provider/, consumer/ or tables/ (wrong directory?)`);
      return 1;
    }
    io.out(formatSummary(rows));
    return 0;
  }
  if (command === "reset") {
    resetLedger({ dir, side: side as Side });
    io.out(`${TOOL} reset (${side} side): OK (no entries in .ledger/${side}.jsonl)`);
    return 0;
  }
  const result = checkContracts({ dir, side: side as Side });
  const report = formatCheckResult(result);
  if (result.problems.length > 0) {
    io.err(report);
    return 1;
  }
  io.out(report);
  return 0;
}
