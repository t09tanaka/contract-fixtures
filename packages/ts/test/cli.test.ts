import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { contractFixtures, runCli, USAGE } from "../src/index.js";
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
      "contract-fixtures check (provider side): OK (4 fixture(s), all verified or read by this side's tests)",
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
      "Hint: .ledger/consumer.jsonl does not exist, but .ledger/provider.jsonl has some. Did the consumer side's tests run, and is consumer the side to check?",
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
    const reset = run(["reset", "--side", "provider", "--dir", dir]);
    assert.equal(reset.code, 0);
    assert.equal(reset.out, "contract-fixtures reset (provider side): OK (no entries in .ledger/provider.jsonl)");
    assert.deepEqual(ledgerLines(dir, "provider"), []);
    assert.equal(run(["check", "--side", "provider", "--dir", dir]).code, 1);
  });

  it("check prints no hint when it passes, and none for problems the ledger does not explain", () => {
    const dir = copyOfContracts();
    exerciseProviderSide(dir);
    assert.doesNotMatch(run(["check", "--side", "provider", "--dir", dir]).out, /Hint/);
    fs.writeFileSync(path.join(dir, "provider", "order.created.json"), "{");
    const result = run(["check", "--side", "provider", "--dir", dir]);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.err, /Hint/);
  });

  it("summary prints one line per fixture and leaves the ledger alone", () => {
    const dir = copyOfContracts();
    const result = run(["summary", "--dir", dir]);
    assert.equal(result.code, 0);
    assert.equal(result.err, "");
    assert.deepEqual(result.out.split("\n"), [
      "FIXTURE                        REQUEST       STATUS  RESPONSE BODY",
      "provider/order.created         POST /orders  201     {created_at: string, id: string, lines: array, status: string, total_minor: number}",
      "provider/order.out-of-stock    POST /orders  409     {error: string}",
      "consumer/create-order.request  POST /orders  -       -",
      "tables/order-total             -             -       2 row(s)",
    ]);
    assert.equal(fs.existsSync(path.join(dir, ".ledger")), false);
    assert.equal(run(["summary"], { CONTRACT_FIXTURES_DIR: dir }).out, result.out);
  });

  it("summary exits 1 for a directory without fixtures", () => {
    const result = run(["summary", "--dir", tempDir()]);
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.match(result.err, /no fixtures found/);
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
      ["summary", "--side", "provider", "--dir", dir],
      ["summary"],
      ["list", "--dir", dir],
    ];
    for (const argv of wrong) {
      const result = run(argv);
      assert.equal(result.code, 2, argv.join(" "));
      assert.match(result.err, /^contract-fixtures: .+\n\ncontract-fixtures — .+\n\nUsage: /, argv.join(" "));
    }
  });

  it("prints the usage for --help", () => {
    const result = run(["--help"]);
    assert.equal(result.code, 0);
    assert.equal(result.out, USAGE);
    assert.match(result.out, /\n\nUsage: contract-fixtures <reset\|check> --side/);
  });

  it("prints the version of package.json for --version", () => {
    const { version } = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) {
      assert.deepEqual(run([flag]), { code: 0, out: version, err: "" });
    }
    const bin = path.resolve(process.cwd(), "bin/contract-fixtures.js");
    assert.equal(execFileSync(process.execPath, [bin, "--version"]).toString(), `${version}\n`);
  });

  it("the copies of the changelog and the licence in this package are those of the repository", () => {
    for (const file of ["CHANGELOG.md", "LICENSE"]) {
      assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(path.join("../..", file), "utf8"), file);
    }
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
