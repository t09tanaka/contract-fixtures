/**
 * Runs the language independent cases in spec/fixtures. The Dart package runs the same files;
 * that both pass is what "the two packages treat a fixture the same way" means.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  canonicalJson,
  checkContracts,
  compactJson,
  ContractCoverageError,
  ContractFixtureError,
  ContractMismatchError,
  ContractUsageError,
  contractFixtures,
  differences,
  formatCheckResult,
  formatSummary,
  parsePlaceholder,
  runCli,
  summarizeContracts,
  USAGE,
  validateConfig,
  validateFixture,
  validateFixtureValue,
  type Kind,
  type ObservedRequest,
  type ObservedResponse,
  type Side,
  type VolatileEntry,
} from "../src/index.js";
import { compilePattern, PatternError } from "../src/pattern.js";
import {
  copyOfContracts,
  everyFileIn,
  ledgerLines,
  loadCases,
  loadHelp,
  tempDir,
  writeFile,
} from "./helpers.js";

/** What {tool} stands for in the shared cases: the name of this package's executable. */
const TOOL = "contract-fixtures";

describe("spec/fixtures/differences.json", () => {
  interface Case {
    case: string;
    expected: unknown;
    actual: unknown;
    volatile: VolatileEntry[];
    differences: { path: string; kind: string; text: string }[];
  }
  for (const c of loadCases<Case>("differences.json")) {
    it(c.case, () => {
      assert.deepEqual(differences(c.expected, c.actual, c.volatile), c.differences);
    });
  }
});

describe("spec/fixtures/validation.json", () => {
  interface Case {
    case: string;
    kind: Kind;
    name: string;
    text?: string;
    value?: unknown;
    issues: { code: string; path: string }[];
    absent?: string[];
    shown?: string[];
    messages?: string[];
    forbidden?: string[];
  }
  for (const c of loadCases<Case>("validation.json")) {
    it(c.case, () => {
      const config = c.forbidden === undefined ? undefined : { forbidden: c.forbidden };
      const issues =
        c.text !== undefined
          ? validateFixture(c.kind, c.name, c.text, config).issues
          : validateFixtureValue(c.kind, c.name, c.value, config);
      assert.deepEqual(
        issues.map((i) => ({ code: i.code, path: i.path })),
        c.issues,
      );
      for (const issue of issues) {
        assert.notEqual(issue.message, "");
        for (const text of c.absent ?? []) assert.ok(!issue.message.includes(text));
      }
      for (const text of c.shown ?? []) assert.ok(issues.some((issue) => issue.message.includes(text)), text);
      if (c.messages !== undefined) assert.deepEqual(issues.map((issue) => issue.message), c.messages);
    });
  }
});

describe("spec/fixtures/configuration.json", () => {
  interface Case {
    case: string;
    text: string;
    forbidden: string[];
    issues: { code: string; path: string }[];
  }
  for (const c of loadCases<Case>("configuration.json")) {
    it(c.case, () => {
      const { config, issues } = validateConfig(c.text);
      assert.deepEqual(
        issues.map((i) => ({ code: i.code, path: i.path })),
        c.issues,
      );
      for (const issue of issues) assert.notEqual(issue.message, "");
      assert.deepEqual(config, { forbidden: c.forbidden });
    });
  }
});

describe("spec/fixtures/canonical.json", () => {
  interface Case {
    case: string;
    input: string;
    pretty: string;
    compact: string;
  }
  for (const c of loadCases<Case>("canonical.json")) {
    it(c.case, () => {
      assert.equal(canonicalJson(JSON.parse(c.input)), c.pretty);
      assert.equal(compactJson(JSON.parse(c.input)), c.compact);
    });
  }
});

describe("spec/fixtures/placeholders.json", () => {
  interface Case {
    value: string;
    placeholder: { kind: string; name: string } | null;
  }
  for (const c of loadCases<Case>("placeholders.json")) {
    it(JSON.stringify(c.value), () => {
      assert.deepEqual(parsePlaceholder(c.value), c.placeholder);
    });
  }
});

describe("spec/fixtures/patterns.json", () => {
  interface Case {
    case: string;
    pattern: string;
    valid: boolean;
    matches?: string[];
    rejects?: string[];
    finds?: string[];
    findsNot?: string[];
    native?: boolean;
  }
  for (const c of loadCases<Case>("patterns.json")) {
    it(c.case, () => {
      if (!c.valid) {
        assert.throws(() => compilePattern(c.pattern), PatternError);
        return;
      }
      const pattern = compilePattern(c.pattern);
      for (const value of c.matches ?? []) assert.equal(pattern.test(value), true, JSON.stringify(value));
      for (const value of c.rejects ?? []) assert.equal(pattern.test(value), false, JSON.stringify(value));
      for (const value of c.finds ?? []) assert.equal(pattern.search(value), true, `search ${JSON.stringify(value)}`);
      for (const value of c.findsNot ?? []) assert.equal(pattern.search(value), false, `search ${JSON.stringify(value)}`);
      if (c.native === false) return;
      const anywhere = new RegExp(c.pattern);
      for (const value of c.finds ?? []) assert.equal(anywhere.test(value), true, `RegExp: ${JSON.stringify(value)}`);
      for (const value of c.findsNot ?? []) assert.equal(anywhere.test(value), false, `RegExp: ${JSON.stringify(value)}`);
      const native = new RegExp(`^(?:${c.pattern})$`);
      for (const value of c.matches ?? []) assert.equal(native.test(value), true, `RegExp: ${JSON.stringify(value)}`);
      for (const value of c.rejects ?? []) assert.equal(native.test(value), false, `RegExp: ${JSON.stringify(value)}`);
    });
  }
});

describe("spec/fixtures/check.json", () => {
  interface Case {
    case: string;
    side: Side;
    ledger: string[];
    noLedger?: boolean;
    otherLedger?: string[];
    files?: Record<string, string>;
    empty?: boolean;
    fixtures: number;
    problems: { file: string; code: string }[];
    hints: string[];
    report: string;
  }
  for (const c of loadCases<Case>("check.json")) {
    it(c.case, () => {
      const dir = c.empty ? tempDir() : copyOfContracts();
      for (const [file, text] of Object.entries(c.files ?? {})) writeFile(dir, file, text);
      const other = c.side === "provider" ? "consumer" : "provider";
      if (!c.noLedger) writeFile(dir, `.ledger/${c.side}.jsonl`, c.ledger.map((l) => l + "\n").join(""));
      if (c.otherLedger) {
        writeFile(dir, `.ledger/${other}.jsonl`, c.otherLedger.map((l) => l + "\n").join(""));
      }

      const result = checkContracts({ dir, side: c.side });

      assert.equal(result.fixtures, c.fixtures);
      assert.deepEqual(
        result.problems.map((p) => ({ file: p.file, code: p.code })),
        c.problems,
      );
      assert.deepEqual(result.hints, c.hints);
      assert.equal(formatCheckResult(result), c.report.replaceAll("{tool}", TOOL));
    });
  }
});

describe("spec/fixtures/cli.json", () => {
  interface Case {
    case: string;
    args: string[];
    env?: Record<string, string>;
    empty?: boolean;
    ledger?: Record<string, string[]>;
    ledgerDirectory?: string[];
    ledgerAfter?: Record<string, string[] | null>;
    exit: number;
    stdout: string;
    stderr: string;
  }
  const help = loadHelp().replaceAll("{tool}", TOOL);
  const { version } = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };

  it("the help is the exported text", () => {
    assert.equal(USAGE, help);
  });

  for (const c of loadCases<Case>("cli.json")) {
    it(c.case, () => {
      const dir = c.empty ? tempDir() : copyOfContracts();
      for (const [side, lines] of Object.entries(c.ledger ?? {})) {
        writeFile(dir, `.ledger/${side}.jsonl`, lines.map((l) => l + "\n").join(""));
      }
      for (const side of c.ledgerDirectory ?? []) {
        fs.mkdirSync(path.join(dir, ".ledger", `${side}.jsonl`), { recursive: true });
      }
      const inDir = (text: string) => text.replaceAll("{dir}", dir);
      const printed = (text: string) =>
        inDir(text).replaceAll("{help}", help).replaceAll("{tool}", TOOL).replaceAll("{version}", version);
      const out: string[] = [];
      const err: string[] = [];

      const code = runCli(c.args.map(inDir), {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        env: Object.fromEntries(Object.entries(c.env ?? {}).map(([name, value]) => [name, inDir(value)])),
      });

      assert.equal(out.join("\n"), printed(c.stdout));
      assert.equal(err.join("\n"), printed(c.stderr));
      assert.equal(code, c.exit);
      for (const [side, lines] of Object.entries(c.ledgerAfter ?? {})) {
        const file = path.join(dir, ".ledger", `${side}.jsonl`);
        if (c.ledgerDirectory?.includes(side)) {
          assert.ok(fs.statSync(file).isDirectory(), file);
          continue;
        }
        assert.equal(fs.existsSync(file), lines !== null, file);
        if (lines !== null) assert.deepEqual(ledgerLines(dir, side), lines);
      }
    });
  }
});

describe("spec/fixtures/summary.json", () => {
  interface Case {
    case: string;
    files?: Record<string, string>;
    empty?: boolean;
    depth?: number;
    rows: number;
    text: string;
  }
  for (const c of loadCases<Case>("summary.json")) {
    it(c.case, () => {
      const dir = c.empty ? tempDir() : copyOfContracts();
      for (const [file, text] of Object.entries(c.files ?? {})) writeFile(dir, file, text);

      const rows = summarizeContracts(c.depth === undefined ? { dir } : { dir, depth: c.depth });

      assert.equal(rows.length, c.rows);
      assert.equal(formatSummary(rows), c.text);
      assert.deepEqual(everyFileIn(dir).filter((file) => file.includes(".ledger")), []);
    });
  }
});

describe("spec/fixtures/coverage.json", () => {
  interface Case {
    case: string;
    names: string[];
    call: "covers" | "prefixes";
    expected: string[];
    prefix?: string;
    message: string | null;
    withoutExpectation?: string[];
    withoutFixture?: string[];
  }
  for (const c of loadCases<Case>("coverage.json")) {
    it(c.case, () => {
      const dir = tempDir();
      for (const name of c.names) writeFile(dir, `provider/${name}.json`, "");
      const contract = contractFixtures({ side: "consumer", dir });

      let error: unknown = null;
      try {
        if (c.call === "prefixes") contract.assertPrefixesCover("provider", c.expected);
        else contract.assertCovers("provider", c.expected, c.prefix === undefined ? {} : { prefix: c.prefix });
      } catch (caught) {
        error = caught;
      }

      if (c.message === null) {
        assert.equal(error, null);
        return;
      }
      assert.ok(error instanceof ContractCoverageError);
      assert.equal(error.message, c.message);
      assert.deepEqual(error.withoutExpectation, c.withoutExpectation);
      assert.deepEqual(error.withoutFixture, c.withoutFixture);
    });
  }
});

describe("spec/fixtures/verify.json", () => {
  interface Case {
    case: string;
    kind: "provider" | "consumer";
    storedText: string | null;
    observed: { name: string };
    update: boolean;
    outcome: string;
    differences?: string[];
    issues?: { code: string; path: string }[];
    message?: string;
    warnings?: string[];
    config?: string;
    written: string | null;
    absent?: string[];
  }
  for (const c of loadCases<Case>("verify.json")) {
    it(c.case, () => {
      const dir = tempDir();
      const relative = `${c.kind}/${c.observed.name}.json`;
      const file = path.join(dir, c.kind, `${c.observed.name}.json`);
      if (c.storedText !== null) writeFile(dir, relative, c.storedText);
      if (c.config !== undefined) writeFile(dir, "config.json", c.config);
      const warnings: string[] = [];
      const contract = contractFixtures({ side: c.kind, dir, update: c.update, warn: (text) => warnings.push(text) });

      let outcome = "ok";
      let lines: string[] | undefined;
      let message = "";
      let said = "";
      let issues: { code: string; path: string }[] | undefined;
      try {
        if (c.kind === "provider") contract.verifyResponse(c.observed as ObservedResponse);
        else contract.verifyRequest(c.observed as ObservedRequest);
      } catch (error) {
        message = String(error instanceof Error ? error.stack : error);
        said = error instanceof Error ? error.message : "";
        if (error instanceof ContractMismatchError) {
          outcome = "mismatch";
          lines = error.differences.map((d) => d.text);
          for (const line of lines) assert.ok(error.message.includes(line));
        } else if (error instanceof ContractUsageError) {
          outcome = "usage";
        } else if (error instanceof ContractFixtureError) {
          issues = error.issues.map((i) => ({ code: i.code, path: i.path }));
          outcome = error.file === "config.json"
            ? "invalid-config"
            : error.issues.some((i) => i.code === "secret-removed")
            ? "refused"
            : c.storedText === null && !c.update && error.issues.length === 0
              ? "missing"
              : error.message.includes("what this side produced")
                ? "invalid-observed"
                : "invalid-stored";
        } else {
          throw error;
        }
      }
      const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (outcome === "ok" && after !== c.storedText) outcome = "written";

      assert.equal(outcome, c.outcome);
      if (c.differences) assert.deepEqual(lines, c.differences);
      if (c.issues) assert.deepEqual(issues, c.issues);
      if (c.message !== undefined) assert.equal(said, c.message);
      assert.deepEqual(warnings, c.warnings ?? []);
      assert.equal(after, c.written ?? c.storedText);
      const succeeded = c.outcome === "ok" || c.outcome === "written";
      assert.deepEqual(
        ledgerLines(dir, c.kind),
        succeeded ? [JSON.stringify({ side: c.kind, action: "verified", file: relative })] : [],
      );
      for (const text of c.absent ?? []) {
        assert.ok(!message.includes(text), "the message of the error holds the real value");
        for (const found of everyFileIn(dir)) {
          assert.ok(!fs.readFileSync(found, "utf8").includes(text), `${found} holds the real value`);
        }
      }
    });
  }
});
