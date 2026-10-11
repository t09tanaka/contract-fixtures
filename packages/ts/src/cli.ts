import fs from "node:fs";
import path from "node:path";

import { checkContracts, formatCheckResult } from "./check.js";
import { DIR_ENV } from "./contract.js";
import { resetLedger } from "./ledger.js";
import type { Side } from "./types.js";

export const USAGE = `Usage: contract-fixtures <command> --side <provider|consumer> [--dir <contracts>]

Commands:
  reset   Forget what earlier test runs of this side did. Run it before the tests.
  check   Fail unless this side's tests verified or read every fixture since the reset,
          and every fixture follows the format.

Options:
  --side  The side whose tests ran: provider or consumer.
  --dir   The contracts directory. Defaults to the environment variable ${DIR_ENV}.

Exit codes: 0 no problems, 1 problems found, 2 wrong usage.`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
}

/** Runs the command line and returns the exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const usage = (message: string): number => {
    io.err(`contract-fixtures: ${message}\n\n${USAGE}`);
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
    const option = /^--(side|dir)(?:=(.*))?$/s.exec(arg);
    if (option) {
      const value = option[2] ?? argv[++i];
      if (value === undefined) return usage(`--${option[1]} needs a value`);
      values[option[1]!] = value;
    } else if (arg.startsWith("-")) {
      return usage(`unknown option ${arg}`);
    } else if (command === undefined) {
      command = arg;
    } else {
      return usage(`unexpected argument ${arg}`);
    }
  }
  if (command === undefined) return usage("missing command");
  if (command !== "check" && command !== "reset") return usage(`unknown command ${command}`);
  const side = values.side;
  if (side !== "provider" && side !== "consumer") {
    return usage("--side must be provider or consumer");
  }
  const given = values.dir ?? io.env[DIR_ENV];
  if (given === undefined || given === "") return usage(`pass --dir or set ${DIR_ENV}`);
  const dir = path.resolve(given);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return usage(`${given} is not a directory`);
  }

  if (command === "reset") {
    resetLedger({ dir, side: side as Side });
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
