import fs from "node:fs";
import path from "node:path";

import { checkContracts, formatCheckResult, TOOL } from "./check.js";
import { declaredReaders, READER_PATTERN, readConfig, requireDeclaredReader } from "./configuration.js";
import { DIR_ENV } from "./contract.js";
import { ContractUsageError } from "./errors.js";
import { ledgerName, resetLedger } from "./ledger.js";
import { formatSummary, summarizeContracts } from "./summary.js";
import type { Side } from "./types.js";
import { VERSION } from "./version.js";

/** The text printed for `--help` and after a usage error. */
export const USAGE = `${TOOL} — shared request/response fixtures that keep an API and its clients in step

Usage: ${TOOL} <reset|check> --side <provider|consumer> [--reader <name>] [--dir <contracts>]
       ${TOOL} summary [--dir <contracts>] [--depth <n>]

Commands:
  reset    Forget what earlier test runs of this side did. Run it before the tests.
  check    Fail unless this side's tests verified or read every fixture since the reset,
           and every fixture follows the format. Run it after all tests of this side.
  summary  Print one line per fixture: request, status, and the keys of the response body
           with their types. Does not touch the ledger.

Options:
  --side <provider|consumer>  The side whose tests ran. Not for summary
  --reader <name>             With --side consumer, in a directory with more than one
                              consumer: the reader whose tests ran. Without it, every
                              reader that config.json declares, one after the other
  --dir <contracts>           The contracts directory: the one that holds provider/, consumer/
                              and tables/, not the directory of a package
                              (default: the environment variable ${DIR_ENV})
  --depth <n>                 For summary: how many levels of objects in the response body
                              to open, 1 to 9 (default: 1, the keys at the top)
  -h, --help                  Show this help
  -v, --version               Show the version

Exit codes: 0 no problems, 1 problems found (summary: no fixtures) or the command could
not finish, 2 wrong usage`;

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
    const option = /^--(side|reader|dir|depth)(?:=(.*))?$/s.exec(arg);
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
  const reader = values.reader;
  if (command === "summary") {
    if (side !== undefined) return usage("summary takes no --side");
    if (reader !== undefined) return usage("summary takes no --reader");
    if (values.depth !== undefined && !/^[1-9]$/.test(values.depth)) {
      return usage("--depth must be a whole number from 1 to 9");
    }
  } else if (side !== "provider" && side !== "consumer") {
    return usage("--side must be provider or consumer");
  } else if (values.depth !== undefined) {
    return usage("--depth is for summary only");
  } else if (reader !== undefined && side !== "consumer") {
    return usage("--reader is for --side consumer only");
  } else if (reader !== undefined && !READER_PATTERN.test(reader)) {
    return usage("--reader must be the name of a reader (lower-case letters, digits and -)");
  }
  const given = values.dir ?? io.env[DIR_ENV];
  if (given === undefined || given === "") return usage(`pass --dir or set ${DIR_ENV}`);
  const dir = path.resolve(given);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return usage(`${given} is not a directory`);
  }

  try {
    if (command === "summary") {
      const rows = summarizeContracts({ dir, depth: Number(values.depth ?? "1") });
      if (rows.length === 0) {
        io.err(`${TOOL} summary: no fixtures found under provider/, consumer/ or tables/ (wrong directory?)`);
        return 1;
      }
      io.out(formatSummary(rows));
      return 0;
    }
    // On the consumer side of a directory that declares readers, a command without
    // --reader is for each of them in turn. Everywhere else there is one ledger.
    const { config } = readConfig(dir);
    if (side === "consumer" && reader !== undefined) requireDeclaredReader(config, reader);
    const declared = side === "consumer" && reader === undefined ? declaredReaders(config) : [];
    let code = 0;
    for (const one of declared.length > 0 ? declared : [reader]) {
      const of = one === undefined ? "" : `, reader ${one}`;
      if (command === "reset") {
        resetLedger({ dir, side: side as Side, reader: one });
        io.out(
          `${TOOL} reset (${side} side${of}): OK (no entries in .ledger/${ledgerName(side as Side, one)}.jsonl)`,
        );
        continue;
      }
      const result = checkContracts({ dir, side: side as Side, reader: one });
      const report = formatCheckResult(result);
      if (result.problems.length > 0) {
        io.err(report);
        code = 1;
      } else {
        io.out(report);
      }
    }
    return code;
  } catch (error) {
    // A ledger that cannot be used says so in words of its own. Anything else is a failure
    // of the file system; the first line is the same in every implementation.
    if (error instanceof ContractUsageError) io.err(error.message);
    else io.err(`${TOOL}: ${command} could not finish\n${String(error)}`);
    return 1;
  }
}
