import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  checkContracts,
  ContractCoverageError,
  ContractFixtureError,
  ContractMismatchError,
  ContractUsageError,
  contractFixtures,
  differences,
  resetLedger,
  resolvePlaceholders,
} from "../src/index.js";
import { compilePattern, PatternError } from "../src/pattern.js";
import { JWT_PATTERN } from "../src/secrets.js";
import { copyOfContracts, everyFileIn, ledgerLines, tempDir, writeFile } from "./helpers.js";

const observedResponse = {
  name: "order.out-of-stock",
  description: "The item is out of stock",
  request: {
    method: "POST",
    path: "/orders",
    headers: { authorization: "<token:customer-1>" },
    body: { sku: "mug-200", quantity: 1 },
  },
  response: { status: 409, body: { error: "out_of_stock" } },
};

describe("contractFixtures", () => {
  it("needs a directory at the first use, not when it is created", () => {
    const saved = process.env.CONTRACT_FIXTURES_DIR;
    delete process.env.CONTRACT_FIXTURES_DIR;
    try {
      // A tool that only loads the test file gets this far without a directory.
      const contract = contractFixtures({ side: "provider" });
      assert.equal(contract.side, "provider");
      const message = /pass the contracts directory as `dir` or set CONTRACT_FIXTURES_DIR/;
      for (const use of [
        () => contract.dir,
        () => contract.list("provider"),
        () => contract.assertCovers("provider", []),
        () => contract.assertPrefixesCover("provider", []),
        () => contract.readTable("order-total"),
        () => contract.readRequest("create-order.request"),
        () => contract.verifyResponse(observedResponse),
      ]) {
        assert.throws(use, (error: unknown) => error instanceof ContractUsageError && message.test(error.message));
      }
      // The environment is read at that first use, and the answer is kept.
      const dir = copyOfContracts();
      process.env.CONTRACT_FIXTURES_DIR = dir;
      assert.equal(contract.dir, path.resolve(dir));
      delete process.env.CONTRACT_FIXTURES_DIR;
      assert.deepEqual(contract.list("tables"), ["order-total"]);
    } finally {
      if (saved === undefined) delete process.env.CONTRACT_FIXTURES_DIR;
      else process.env.CONTRACT_FIXTURES_DIR = saved;
    }
  });

  it("takes the directory and update mode from the environment", () => {
    const dir = tempDir();
    const savedCi = process.env.CI;
    delete process.env.CI;
    process.env.CONTRACT_FIXTURES_DIR = dir;
    process.env.CONTRACT_FIXTURES_UPDATE = "1";
    try {
      const contract = contractFixtures({ side: "provider" });
      assert.equal(contract.dir, path.resolve(dir));
      assert.equal(contract.update, true);
      assert.equal(contractFixtures({ side: "provider", update: false }).update, false);
      process.env.CONTRACT_FIXTURES_UPDATE = "true";
      assert.equal(contractFixtures({ side: "provider" }).update, false);

      // In CI the environment variable is refused; an explicit option is not.
      process.env.CONTRACT_FIXTURES_UPDATE = "1";
      process.env.CI = "true";
      assert.throws(() => contractFixtures({ side: "provider" }), /is set in CI/);
      assert.equal(contractFixtures({ side: "provider", update: true }).update, true);
      assert.equal(contractFixtures({ side: "provider", update: false }).update, false);
    } finally {
      if (savedCi === undefined) delete process.env.CI;
      else process.env.CI = savedCi;
      delete process.env.CONTRACT_FIXTURES_DIR;
      delete process.env.CONTRACT_FIXTURES_UPDATE;
    }
  });

  it("rejects an unknown side", () => {
    assert.throws(
      () => contractFixtures({ side: "client" as "consumer", dir: tempDir() }),
      ContractUsageError,
    );
  });

  it("only lets the provider side verify responses and read requests", () => {
    const dir = copyOfContracts();
    const consumer = contractFixtures({ side: "consumer", dir });
    assert.throws(() => consumer.verifyResponse(observedResponse), ContractUsageError);
    assert.throws(() => consumer.readRequest("create-order.request"), ContractUsageError);
    assert.deepEqual(ledgerLines(dir, "consumer"), []);
  });

  it("only lets the consumer side verify requests and read responses", () => {
    const dir = copyOfContracts();
    const provider = contractFixtures({ side: "provider", dir });
    assert.throws(
      () =>
        provider.verifyRequest({
          name: "create-order.request",
          description: "x",
          request: { method: "POST", path: "/orders" },
        }),
      ContractUsageError,
    );
    assert.throws(() => provider.readResponse("order.created"), ContractUsageError);
    assert.deepEqual(ledgerLines(dir, "provider"), []);
  });

  it("reads a response and records it", () => {
    const dir = copyOfContracts();
    const fixture = contractFixtures({ side: "consumer", dir }).readResponse("order.created");
    assert.equal(fixture.response.status, 201);
    assert.equal((fixture.response.body as { id: string }).id, "ord_81f3");
    assert.equal(fixture.request.headers?.authorization, "<token:customer-1>");
    assert.deepEqual(ledgerLines(dir, "consumer"), [
      '{"side":"consumer","action":"read","file":"provider/order.created.json"}',
    ]);
  });

  it("reads a request and a table and records them", () => {
    const dir = copyOfContracts();
    const provider = contractFixtures({ side: "provider", dir });
    assert.equal(provider.readRequest("create-order.request").request.path, "/orders");
    const table = provider.readTable<{ case: string; expected_minor: number }>("order-total");
    assert.deepEqual(
      table.rows.map((row) => row.expected_minor),
      [1200, 899],
    );
    assert.deepEqual(ledgerLines(dir, "provider"), [
      '{"side":"provider","action":"read","file":"consumer/create-order.request.json"}',
      '{"side":"provider","action":"read","file":"tables/order-total.json"}',
    ]);
  });

  it("does not record a read that failed", () => {
    const dir = copyOfContracts();
    writeFile(dir, "provider/broken.json", '{"format":2}');
    const consumer = contractFixtures({ side: "consumer", dir });
    assert.throws(() => consumer.readResponse("no-such-fixture"), ContractFixtureError);
    assert.throws(() => consumer.readResponse("broken"), /does not follow the format/);
    assert.deepEqual(ledgerLines(dir, "consumer"), []);
  });

  it("does not read outside the contracts directory", () => {
    const consumer = contractFixtures({ side: "consumer", dir: copyOfContracts() });
    assert.throws(() => consumer.readResponse("../consumer/create-order.request"), ContractUsageError);
    assert.throws(() => consumer.readTable(""), ContractUsageError);
  });

  it("reading never writes, also in update mode", () => {
    const dir = copyOfContracts();
    const consumer = contractFixtures({ side: "consumer", dir, update: true });
    assert.throws(() => consumer.readResponse("no-such-fixture"), ContractFixtureError);
    assert.equal(fs.existsSync(path.join(dir, "provider", "no-such-fixture.json")), false);
  });

  it("lists fixture names, sorted, optionally by prefix", () => {
    const dir = copyOfContracts();
    writeFile(dir, "provider/README.md", "notes");
    const contract = contractFixtures({ side: "consumer", dir });
    assert.deepEqual(contract.list("provider"), ["order.created", "order.out-of-stock"]);
    assert.deepEqual(contract.list("provider", { prefix: "order.c" }), ["order.created"]);
    assert.deepEqual(contract.list("tables"), ["order-total"]);
    assert.deepEqual(contractFixtures({ side: "consumer", dir: tempDir() }).list("consumer"), []);
  });

  it("assertCovers passes when the expectations name exactly the fixtures", () => {
    const contract = contractFixtures({ side: "consumer", dir: copyOfContracts() });
    contract.assertCovers("provider", ["order.out-of-stock", "order.created"]);
    contract.assertCovers("provider", new Set(["order.created"]), { prefix: "order.c" });
  });

  it("assertCovers fails for a fixture without an expectation and the reverse", () => {
    const contract = contractFixtures({ side: "consumer", dir: copyOfContracts() });
    assert.throws(
      () => contract.assertCovers("provider", ["order.created", "order.refunded"]),
      (error: unknown) => {
        assert.ok(error instanceof ContractCoverageError);
        assert.deepEqual(error.withoutExpectation, ["order.out-of-stock"]);
        assert.deepEqual(error.withoutFixture, ["order.refunded"]);
        assert.match(error.message, /provider\/order\.out-of-stock\.json: no expectation/);
        assert.match(error.message, /order\.refunded: expected here/);
        return true;
      },
    );
  });

  it("drops undefined and keeps what goes over the wire when verifying", () => {
    const dir = copyOfContracts();
    const provider = contractFixtures({ side: "provider", dir });
    provider.verifyResponse({
      ...observedResponse,
      request: { ...observedResponse.request, body: { sku: "mug-200", quantity: 1, note: undefined } },
      volatile: undefined,
    });
    assert.equal(ledgerLines(dir, "provider").length, 1);
  });

  it("refuses NaN and Infinity instead of recording null", () => {
    const dir = tempDir();
    const provider = contractFixtures({ side: "provider", dir, update: true });
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(
        () =>
          provider.verifyResponse({
            ...observedResponse,
            response: { status: 200, body: { total: bad } },
          }),
        (error: unknown) =>
          error instanceof ContractFixtureError &&
          /what this side produced is not a valid fixture/.test(error.message),
      );
    }
    assert.equal(fs.existsSync(path.join(dir, "provider")), false);
    assert.deepEqual(ledgerLines(dir, "provider"), []);
  });

  it("reports a file that is not UTF-8 as an invalid fixture", () => {
    const dir = copyOfContracts();
    fs.writeFileSync(
      path.join(dir, "provider", "order.created.json"),
      Buffer.concat([Buffer.from('{"description":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    );
    const consumer = contractFixtures({ side: "consumer", dir });
    assert.throws(() => consumer.readResponse("order.created"), /is not valid UTF-8/);
    const problems = checkContracts({ dir, side: "consumer" }).problems;
    assert.deepEqual(
      problems.filter((p) => p.code === "invalid").map((p) => [p.file, p.message]),
      [["provider/order.created.json", "invalid fixture: (root) is not valid UTF-8"]],
    );
  });

  it("follows a symbolic link to a fixture and ignores a dangling one", (t) => {
    const dir = copyOfContracts();
    try {
      fs.symlinkSync(
        path.join(dir, "provider", "order.created.json"),
        path.join(dir, "provider", "linked.json"),
      );
      fs.symlinkSync(path.join(dir, "nowhere.json"), path.join(dir, "provider", "dangling.json"));
    } catch {
      t.skip("symbolic links are not available here");
      return;
    }
    const consumer = contractFixtures({ side: "consumer", dir });
    assert.deepEqual(consumer.list("provider"), ["linked", "order.created", "order.out-of-stock"]);
    const result = checkContracts({ dir, side: "consumer" });
    assert.equal(result.fixtures, 5);
    // The linked file says it is called order.created, so it is reported as invalid.
    assert.ok(result.problems.some((p) => p.file === "provider/linked.json" && p.code === "invalid"));
  });

  it("resetLedger forgets one side only", () => {
    const dir = copyOfContracts();
    contractFixtures({ side: "provider", dir }).readTable("order-total");
    contractFixtures({ side: "consumer", dir }).readTable("order-total");
    resetLedger({ dir, side: "provider" });
    assert.deepEqual(ledgerLines(dir, "provider"), []);
    assert.equal(ledgerLines(dir, "consumer").length, 1);
    resetLedger({ dir, side: "provider" });
  });

  it("a ledger that cannot be written fails the verify and the read", () => {
    const dir = copyOfContracts();
    fs.mkdirSync(path.join(dir, ".ledger", "provider.jsonl"), { recursive: true });
    const contract = contractFixtures({ side: "provider", dir });
    const unusable = (error: unknown): boolean =>
      error instanceof ContractUsageError &&
      error.message ===
        "contract-fixtures: the ledger .ledger/provider.jsonl cannot be used " +
          "(it is not a file, or it cannot be read or written)";
    assert.throws(() => contract.readTable("order-total"), unusable);
    assert.throws(() => contract.verifyResponse(observedResponse), unusable);
    assert.throws(() => resetLedger({ dir, side: "provider" }), unusable);
    assert.throws(() => checkContracts({ dir, side: "provider" }), unusable);
    // The other side is not affected.
    contractFixtures({ side: "consumer", dir }).readTable("order-total");
    assert.equal(ledgerLines(dir, "consumer").length, 1);
  });

  it("a file in the place of the ledger directory: nothing to reset or to check, and no place to write", () => {
    const dir = copyOfContracts();
    fs.writeFileSync(path.join(dir, ".ledger"), "");
    resetLedger({ dir, side: "provider" });
    assert.equal(checkContracts({ dir, side: "provider" }).untouched, true);
    assert.throws(
      () => contractFixtures({ side: "provider", dir }).readTable("order-total"),
      /the ledger \.ledger\/provider\.jsonl cannot be used/,
    );
  });

  it("the configuration of the directory is read for every verify and read", () => {
    const dir = copyOfContracts();
    const consumer = contractFixtures({ side: "consumer", dir });
    assert.equal(consumer.readResponse("order.created").response.status, 201);
    // What it forbids is refused on the reading side too.
    writeFile(dir, "config.json", '{ "format": 1, "forbidden": ["^ord_"] }');
    assert.throws(
      () => consumer.readResponse("order.created"),
      (error: unknown) =>
        error instanceof ContractFixtureError &&
        error.file === "provider/order.created.json" &&
        error.issues.every((issue) => issue.code === "forbidden") &&
        !error.message.includes("ord_81f3"),
    );
    // A configuration that is not valid stops reading and verifying, and nothing is recorded.
    writeFile(dir, "config.json", "{");
    const invalid = (error: unknown): boolean =>
      error instanceof ContractFixtureError &&
      error.file === "config.json" &&
      error.message === "config.json of the contracts directory does not follow the format:\n  (root): is not valid JSON";
    assert.throws(() => consumer.readTable("order-total"), invalid);
    assert.throws(() => contractFixtures({ side: "provider", dir }).verifyResponse(observedResponse), invalid);
    assert.deepEqual(ledgerLines(dir, "consumer").length, 1);
    assert.deepEqual(ledgerLines(dir, "provider"), []);
    // Bytes that are not UTF-8 are reported like a fixture's.
    fs.writeFileSync(path.join(dir, "config.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    assert.deepEqual(
      checkContracts({ dir, side: "consumer" }).problems.filter((p) => p.file === "config.json").map((p) => p.message),
      ["invalid configuration: (root) is not valid UTF-8"],
    );
  });

  it("a ledger directory that cannot be looked at is not taken for a missing ledger", (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs a directory that cannot be read");
    const dir = copyOfContracts();
    contractFixtures({ side: "provider", dir }).readTable("order-total");
    fs.chmodSync(path.join(dir, ".ledger"), 0o000);
    try {
      const unusable = /the ledger \.ledger\/provider\.jsonl cannot be used/;
      assert.throws(() => resetLedger({ dir, side: "provider" }), unusable);
      assert.throws(() => checkContracts({ dir, side: "provider" }), unusable);
      assert.throws(() => contractFixtures({ side: "provider", dir }).readTable("order-total"), unusable);
    } finally {
      fs.chmodSync(path.join(dir, ".ledger"), 0o755);
    }
    assert.equal(ledgerLines(dir, "provider").length, 1);
  });

  it("a directory in the place of config.json is a configuration that is not valid", () => {
    const dir = copyOfContracts();
    fs.mkdirSync(path.join(dir, "config.json"));
    assert.deepEqual(
      checkContracts({ dir, side: "consumer" }).problems.filter((p) => p.file === "config.json").map((p) => p.message),
      ["invalid configuration: (root) is not a file"],
    );
    assert.throws(() => contractFixtures({ side: "consumer", dir }).readTable("order-total"), /config\.json of the contracts directory/);
  });

  it("a file in the place of a directory of fixtures holds no fixtures", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "provider"), "");
    assert.deepEqual(contractFixtures({ side: "provider", dir }).list("provider"), []);
    assert.deepEqual(checkContracts({ dir, side: "provider" }).problems.map((p) => p.code), ["empty"]);
  });
});

describe("resolvePlaceholders", () => {
  it("replaces placeholders anywhere in a JSON value and leaves the input alone", () => {
    const headers = { authorization: "<token:customer-1>", accept: "application/json" };
    const resolved = resolvePlaceholders({ headers, list: ["<token:customer-1>", 1, null] }, (kind, name) =>
      kind === "token" ? `Bearer real-${name}` : undefined,
    );
    assert.deepEqual(resolved, {
      headers: { authorization: "Bearer real-customer-1", accept: "application/json" },
      list: ["Bearer real-customer-1", 1, null],
    });
    assert.equal(headers.authorization, "<token:customer-1>");
  });

  it("fails for a placeholder without a value", () => {
    assert.throws(
      () => resolvePlaceholders({ a: "<key:unknown>" }, () => undefined),
      /no value for the placeholder <key:unknown>/,
    );
  });
});

describe("secret paths", () => {
  /** A string of the shape of a token; a new one on every call, as a real API would issue. */
  let issued = 0;
  const base64url = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const issueToken = (): string =>
    [base64url({ alg: "HS256" }), base64url({ sub: "customer-1", n: ++issued }), "c2lnbmF0dXJl"].join(".");

  const signInExchange = (token: unknown, seconds = 3600) => ({
    name: "session.created",
    description: "Signing in returns an access token",
    request: {
      method: "POST",
      path: "/sessions",
      body: { email: "customer-1@example.test", password: "<password:customer-1>" },
    },
    response: { status: 200, body: { access_token: token, expires_in: seconds } },
  });
  const secret = { "response.body.access_token": "<token:session-1>" };

  const everythingIn = (dir: string): string =>
    everyFileIn(dir)
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
  const thrownBy = (run: () => void): Error => {
    try {
      run();
    } catch (error) {
      return error as Error;
    }
    throw new Error("nothing was thrown");
  };

  it("negative control: without a secret path, a token cannot be written", () => {
    const dir = tempDir();
    const provider = contractFixtures({ side: "provider", dir, update: true });
    const token = issueToken();

    const error = thrownBy(() => provider.verifyResponse(signInExchange(token)));

    assert.ok(error instanceof ContractFixtureError);
    assert.deepEqual(
      error.issues.map((issue) => `${issue.code} ${issue.path}`),
      ["jwt response.body.access_token"],
    );
    assert.ok(!String(error.stack).includes(token));
    assert.deepEqual(everyFileIn(dir), []);
  });

  it("with a secret path, the real value is nowhere: not in a file, the ledger or a message", () => {
    const dir = tempDir();
    const first = issueToken();
    contractFixtures({ side: "provider", dir, update: true }).verifyResponse({
      ...signInExchange(first),
      secret,
    });

    // Another run issues another token; the stored placeholder still matches.
    const provider = contractFixtures({ side: "provider", dir, update: false });
    const second = issueToken();
    provider.verifyResponse({ ...signInExchange(second), secret });

    // A difference elsewhere is reported without the token.
    const third = issueToken();
    const error = thrownBy(() => provider.verifyResponse({ ...signInExchange(third, 60), secret }));
    assert.ok(error instanceof ContractMismatchError);
    assert.deepEqual(
      error.differences.map((d) => d.text),
      ["response.body.expires_in: 3600 -> 60"],
    );

    const written = everythingIn(dir) + String(error.stack);
    assert.match(written, /"access_token": "<token:session-1>"/);
    assert.equal(ledgerLines(dir, "provider").length, 2);
    for (const token of [first, second, third]) assert.ok(!written.includes(token));
    assert.ok(!JWT_PATTERN.test(written));
  });

  it("a test that stops passing the secret path does not print the value either", () => {
    const dir = tempDir();
    contractFixtures({ side: "provider", dir, update: true }).verifyResponse({
      ...signInExchange("opaque-value-1"),
      secret,
    });

    const error = thrownBy(() =>
      contractFixtures({ side: "provider", dir, update: false }).verifyResponse(
        signInExchange("opaque-value-2"),
      ),
    );

    assert.ok(error instanceof ContractMismatchError);
    assert.deepEqual(
      error.differences.map((d) => d.path),
      ["secret"],
    );
    assert.ok(!String(error.stack).includes("opaque-value-2"));
  });

  it("a value that is not a string, or a path that matches nothing, is an error without the value", () => {
    const provider = contractFixtures({ side: "provider", dir: tempDir(), update: true });

    const notString = thrownBy(() =>
      provider.verifyResponse({ ...signInExchange({ value: "opaque-value-3" }), secret }),
    );
    assert.ok(notString instanceof ContractFixtureError);
    assert.deepEqual(
      notString.issues.map((issue) => `${issue.code} ${issue.path}`),
      ["secret-value response.body.access_token"],
    );
    assert.ok(!notString.message.includes("opaque-value-3"));

    const unmatched = thrownBy(() =>
      provider.verifyResponse({
        ...signInExchange("opaque-value-4"),
        secret: { "response.body.refresh_token": "<token:renewal-1>" },
      }),
    );
    assert.ok(unmatched instanceof ContractFixtureError);
    assert.deepEqual(
      unmatched.issues.map((issue) => `${issue.code} ${issue.path}`),
      ["secret-unmatched secret.response.body.refresh_token"],
    );
    assert.deepEqual(everyFileIn(provider.dir), []);
  });

  it("update mode does not drop a secret path, and says which one without the value", () => {
    const dir = tempDir();
    const update = contractFixtures({ side: "provider", dir, update: true });
    update.verifyResponse({ ...signInExchange("opaque-value-5"), secret });
    const before = everythingIn(dir);

    const error = thrownBy(() => update.verifyResponse(signInExchange("opaque-value-6")));

    assert.ok(error instanceof ContractFixtureError);
    assert.equal(
      error.message,
      "contract fixture provider/session.created.json is not updated, because that would drop a secret path:\n" +
        "  secret.response.body.access_token: is a secret path of the stored fixture, but this test does not pass it\n" +
        "Pass the path as `secret` in this test, or remove it from the stored file by hand.",
    );
    assert.equal(everythingIn(dir), before);
    assert.ok(!before.includes("opaque-value"));
  });

  it("a number that is not JSON is reported before a header that is given twice", () => {
    const consumer = contractFixtures({ side: "consumer", dir: tempDir(), update: true });
    const request = (body: unknown) => ({
      name: "create-order.request",
      description: "The request the client sends to place an order",
      request: { method: "POST", path: "/orders", headers: { Accept: "a", accept: "b" }, body },
    });

    assert.ok(thrownBy(() => consumer.verifyRequest(request({ n: NaN }))) instanceof ContractFixtureError);
    assert.ok(thrownBy(() => consumer.verifyRequest(request({ n: 1 }))) instanceof ContractUsageError);
  });

  it("does not change what the test passed in", () => {
    const provider = contractFixtures({ side: "provider", dir: tempDir(), update: true });
    const token = issueToken();
    const observed = { ...signInExchange(token), secret };

    provider.verifyResponse(observed);

    assert.equal(observed.response.body.access_token, token);
  });

  it("the reading side gets the placeholder and puts a value of its own in", () => {
    const dir = tempDir();
    contractFixtures({ side: "provider", dir, update: true }).verifyResponse({
      ...signInExchange(issueToken()),
      secret,
    });

    const fixture = contractFixtures({ side: "consumer", dir }).readResponse("session.created");

    assert.deepEqual(fixture.secret, secret);
    assert.deepEqual(
      resolvePlaceholders(fixture.response.body, (kind, name) => `${kind} of ${name}`),
      { access_token: "token of session-1", expires_in: 3600 },
    );
    assert.deepEqual(checkContracts({ dir, side: "consumer" }).problems, []);
  });

  it("uses the expression that spec/format.md gives for a token", () => {
    const format = fs.readFileSync(path.resolve(process.cwd(), "../../spec/format.md"), "utf8");
    assert.ok(format.includes(`\n\`\`\`\n${JWT_PATTERN.source}\n\`\`\`\n`));
  });
});

describe("response headers", () => {
  const signIn = (cookies: string | string[]) => ({
    name: "session.created",
    description: "Signing in sets the session cookies",
    request: { method: "POST", path: "/sessions", headers: { Accept: ["application/json", "text/plain"] } },
    response: { status: 204, headers: { "Set-Cookie": cookies, "Cache-Control": "no-store" } },
  });

  it("records them with lower-case names, and the reading side gets them back", () => {
    const dir = tempDir();
    contractFixtures({ side: "provider", dir, update: true }).verifyResponse({
      ...signIn(["session=opaque-1; HttpOnly", "theme=dark"]),
      secret: { "response.headers.set-cookie.0": "<cookie:session-1>" },
    });

    const { request, response } = contractFixtures({ side: "consumer", dir }).readResponse(
      "session.created",
    );

    assert.deepEqual(request.headers, { accept: ["application/json", "text/plain"] });
    assert.deepEqual(response.headers, {
      "set-cookie": ["<cookie:session-1>", "theme=dark"],
      "cache-control": "no-store",
    });
    assert.equal(response.body, undefined);
    assert.ok(!everyFileIn(dir).some((file) => fs.readFileSync(file, "utf8").includes("opaque-1")));
  });

  it("compares the values of a repeated header in order", () => {
    const dir = tempDir();
    contractFixtures({ side: "provider", dir, update: true }).verifyResponse(signIn(["a=1", "b=2"]));
    const provider = contractFixtures({ side: "provider", dir, update: false });

    provider.verifyResponse(signIn(["a=1", "b=2"]));
    assert.throws(() => provider.verifyResponse(signIn(["b=2", "a=1"])), ContractMismatchError);
    assert.throws(() => provider.verifyResponse(signIn("a=1")), ContractMismatchError);
  });
});

describe("volatile entries with a pattern", () => {
  const created = (id: unknown) => ({
    name: "order.created",
    description: "An order is accepted",
    request: { method: "POST", path: "/orders", body: { sku: "tea-100", quantity: 2 } },
    response: { status: 201, body: { id, lines: [{ created_at: "2026-01-15T09:30:00Z" }] } },
    volatile: [
      { path: "response.body.id", pattern: "^ord_[a-z0-9]+$" },
      "response.body.**.created_at",
    ],
  });

  it("are stored as given and come back to the reading side", () => {
    const dir = tempDir();
    contractFixtures({ side: "provider", dir, update: true }).verifyResponse(created("ord_81f3"));

    const fixture = contractFixtures({ side: "consumer", dir }).readResponse("order.created");

    assert.deepEqual(fixture.volatile, created("").volatile);
  });

  it("let the value change, but not its shape", () => {
    const dir = tempDir();
    contractFixtures({ side: "provider", dir, update: true }).verifyResponse(created("ord_81f3"));
    const provider = contractFixtures({ side: "provider", dir, update: false });

    provider.verifyResponse(created("ord_zz9"));
    assert.throws(() => provider.verifyResponse(created("zz9")), ContractMismatchError);
    assert.throws(() => provider.verifyResponse(created(9)), ContractMismatchError);
  });

  it("are never written with a value that does not match", () => {
    const dir = tempDir();
    const update = contractFixtures({ side: "provider", dir, update: true });

    assert.throws(() => update.verifyResponse(created("zz9")), ContractFixtureError);
    assert.deepEqual(everyFileIn(dir), []);
  });

  it("the comparison refuses an entry that is not one", () => {
    assert.throws(() => differences({}, {}, [{ path: "a" } as never]), TypeError);
    assert.throws(() => differences({}, {}, [{ path: "a", pattern: "(" }]), PatternError);
  });

  it("a pattern that would stall a backtracking engine is answered at once", () => {
    const pattern = compilePattern("(a+)+b|(a|aa)*c|(a?){200}a{200}");
    const long = "a".repeat(20000);

    assert.equal(pattern.test(long), false);
    assert.equal(pattern.test(`${long}b`), true);
    assert.equal(pattern.test(`${long}c`), true);
    assert.equal(pattern.test("a".repeat(300)), true);
  });
});

describe("a string in the place of a list of names", () => {
  it("is refused by assertCovers and assertPrefixesCover", () => {
    const contract = contractFixtures({ side: "consumer", dir: copyOfContracts() });
    assert.throws(() => contract.assertPrefixesCover("provider", "order."), /takes a list of names, not one string/);
    assert.throws(() => contract.assertCovers("provider", "order.created"), /takes a list of names, not one string/);
  });
});
