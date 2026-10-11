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
  ContractFixtureError,
  ContractMismatchError,
  ContractUsageError,
  contractFixtures,
  differences,
  parsePlaceholder,
  validateFixture,
  validateFixtureValue,
  type Kind,
  type ObservedRequest,
  type ObservedResponse,
  type Side,
} from "../src/index.js";
import { copyOfContracts, ledgerLines, loadCases, tempDir, writeFile } from "./helpers.js";

describe("spec/fixtures/differences.json", () => {
  interface Case {
    case: string;
    expected: unknown;
    actual: unknown;
    volatile: string[];
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
  }
  for (const c of loadCases<Case>("validation.json")) {
    it(c.case, () => {
      const issues =
        c.text !== undefined
          ? validateFixture(c.kind, c.name, c.text).issues
          : validateFixtureValue(c.kind, c.name, c.value);
      assert.deepEqual(
        issues.map((i) => ({ code: i.code, path: i.path })),
        c.issues,
      );
      for (const issue of issues) assert.notEqual(issue.message, "");
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

describe("spec/fixtures/check.json", () => {
  interface Case {
    case: string;
    side: Side;
    ledger: string[];
    otherLedger?: string[];
    files?: Record<string, string>;
    empty?: boolean;
    fixtures: number;
    problems: { file: string; code: string }[];
  }
  for (const c of loadCases<Case>("check.json")) {
    it(c.case, () => {
      const dir = c.empty ? tempDir() : copyOfContracts();
      for (const [file, text] of Object.entries(c.files ?? {})) writeFile(dir, file, text);
      const other = c.side === "provider" ? "consumer" : "provider";
      writeFile(dir, `.ledger/${c.side}.jsonl`, c.ledger.map((l) => l + "\n").join(""));
      if (c.otherLedger) {
        writeFile(dir, `.ledger/${other}.jsonl`, c.otherLedger.map((l) => l + "\n").join(""));
      }

      const result = checkContracts({ dir, side: c.side });

      assert.equal(result.fixtures, c.fixtures);
      assert.deepEqual(
        result.problems.map((p) => ({ file: p.file, code: p.code })),
        c.problems,
      );
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
    written: string | null;
  }
  for (const c of loadCases<Case>("verify.json")) {
    it(c.case, () => {
      const dir = tempDir();
      const relative = `${c.kind}/${c.observed.name}.json`;
      const file = path.join(dir, c.kind, `${c.observed.name}.json`);
      if (c.storedText !== null) writeFile(dir, relative, c.storedText);
      const contract = contractFixtures({ side: c.kind, dir, update: c.update });

      let outcome = "ok";
      let lines: string[] | undefined;
      try {
        if (c.kind === "provider") contract.verifyResponse(c.observed as ObservedResponse);
        else contract.verifyRequest(c.observed as ObservedRequest);
      } catch (error) {
        if (error instanceof ContractMismatchError) {
          outcome = "mismatch";
          lines = error.differences.map((d) => d.text);
          for (const line of lines) assert.ok(error.message.includes(line));
        } else if (error instanceof ContractUsageError) {
          outcome = "usage";
        } else if (error instanceof ContractFixtureError) {
          outcome =
            c.storedText === null && !c.update && error.issues.length === 0
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
      assert.equal(after, c.written ?? c.storedText);
      const succeeded = c.outcome === "ok" || c.outcome === "written";
      assert.deepEqual(
        ledgerLines(dir, c.kind),
        succeeded ? [JSON.stringify({ side: c.kind, action: "verified", file: relative })] : [],
      );
    });
  }
});
