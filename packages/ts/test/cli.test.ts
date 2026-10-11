import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { contractFixtures, runCli } from "../src/index.js";
import { copyOfContracts, ledgerLines, tempDir } from "./helpers.js";

function run(argv: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t), env });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function exerciseProviderSide(dir: string): void {
  const provider = contractFixtures({ side: "provider", dir, update: true });
  for (const name of ["order.created", "order.out-of-stock"]) {
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "provider", `${name}.json`), "utf8"));
    provider.verifyResponse(stored);
  }
  provider.readRequest("create-order.request");
  provider.readTable("order-total");
}

describe("command line", () => {
  it("check exits 0 when this side did everything", () => {
    const dir = copyOfContracts();
    exerciseProviderSide(dir);
    const result = run(["check", "--side", "provider", "--dir", dir]);
    assert.equal(result.code, 0);
    assert.equal(
      result.out,
      "contract-fixtures check (provider side): 4 fixture(s), all verified or read by this side's tests.",
    );
    assert.equal(result.err, "");
  });

  it("check exits 1 and names every fixture this side did not touch", () => {
    const dir = copyOfContracts();
    exerciseProviderSide(dir);
    const result = run(["check", "--side=consumer", `--dir=${dir}`]);
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.deepEqual(result.err.split("\n"), [
      "contract-fixtures check (consumer side): 4 problem(s) in 4 fixture(s)",
      "  - provider/order.created.json: not read by the consumer side's tests (add a test that feeds it to the real code)",
      "  - provider/order.out-of-stock.json: not read by the consumer side's tests (add a test that feeds it to the real code)",
      "  - consumer/create-order.request.json: not verified by the consumer side's tests (stale: delete it, or restore the test that produces it)",
      "  - tables/order-total.json: not read by the consumer side's tests (add a test that feeds it to the real code)",
      "Run `contract-fixtures reset` and the consumer side's tests before this check.",
    ]);
  });

  it("check exits 1 for an empty directory", () => {
    const result = run(["check", "--side", "provider", "--dir", tempDir()]);
    assert.equal(result.code, 1);
    assert.match(result.err, /no fixtures found/);
  });

  it("reset forgets this side's ledger, so the next check fails", () => {
    const dir = copyOfContracts();
    exerciseProviderSide(dir);
    assert.equal(run(["reset", "--side", "provider", "--dir", dir]).code, 0);
    assert.deepEqual(ledgerLines(dir, "provider"), []);
    assert.equal(run(["check", "--side", "provider", "--dir", dir]).code, 1);
  });

  it("takes the directory from the environment", () => {
    const dir = copyOfContracts();
    exerciseProviderSide(dir);
    assert.equal(run(["check", "--side", "provider"], { CONTRACT_FIXTURES_DIR: dir }).code, 0);
  });

  it("exits 2 for wrong usage", () => {
    const dir = copyOfContracts();
    const wrong: string[][] = [
      [],
      ["verify", "--side", "provider", "--dir", dir],
      ["check", "--dir", dir],
      ["check", "--side", "client", "--dir", dir],
      ["check", "--side", "provider"],
      ["check", "--side", "provider", "--dir", path.join(dir, "no-such-directory")],
      ["check", "--side", "provider", "--dir", path.join(dir, "provider", "order.created.json")],
      ["check", "--side", "provider", "--dir", dir, "--strict"],
      ["check", "extra", "--side", "provider", "--dir", dir],
      ["check", "--side"],
    ];
    for (const argv of wrong) {
      const result = run(argv);
      assert.equal(result.code, 2, argv.join(" "));
      assert.match(result.err, /^contract-fixtures: .+\n\nUsage: /, argv.join(" "));
    }
  });

  it("prints the usage for --help", () => {
    const result = run(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.out, /^Usage: contract-fixtures <command>/);
  });

  it("the built executable sets the exit code", () => {
    const bin = path.resolve(process.cwd(), "bin/contract-fixtures.js");
    const dir = copyOfContracts();
    exerciseProviderSide(dir);
    const ok = execFileSync(process.execPath, [bin, "check", "--side", "provider", "--dir", dir]);
    assert.match(ok.toString(), /4 fixture\(s\)/);
    const failed = spawnSync(process.execPath, [bin, "check", "--side", "consumer", "--dir", dir]);
    assert.equal(failed.status, 1);
    assert.equal(spawnSync(process.execPath, [bin, "check"]).status, 2);
  });

  it("the package can be loaded with require() as well as import", () => {
    const dir = copyOfContracts();
    const script =
      'const { contractFixtures } = require("@t09tanaka/contract-fixtures");' +
      'const c = contractFixtures({ side: "consumer", dir: process.argv[1] });' +
      'process.stdout.write(String(c.readResponse("order.created").response.status));';
    assert.equal(execFileSync(process.execPath, ["-e", script, dir]).toString(), "201");
    const esm =
      'import { contractFixtures } from "@t09tanaka/contract-fixtures";' +
      'const c = contractFixtures({ side: "provider", dir: process.argv[1] });' +
      'process.stdout.write(String(c.list("provider").length));';
    assert.equal(
      execFileSync(process.execPath, ["--input-type=module", "-e", esm, dir]).toString(),
      "2",
    );
  });
});
