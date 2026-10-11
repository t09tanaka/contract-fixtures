import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ContractCoverageError,
  ContractFixtureError,
  ContractUsageError,
  contractFixtures,
  resetLedger,
  resolvePlaceholders,
} from "../src/index.js";
import { copyOfContracts, ledgerLines, tempDir, writeFile } from "./helpers.js";

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
  it("needs a directory", () => {
    const saved = process.env.CONTRACT_FIXTURES_DIR;
    delete process.env.CONTRACT_FIXTURES_DIR;
    try {
      assert.throws(() => contractFixtures({ side: "provider" }), ContractUsageError);
    } finally {
      if (saved !== undefined) process.env.CONTRACT_FIXTURES_DIR = saved;
    }
  });

  it("takes the directory and update mode from the environment", () => {
    const dir = tempDir();
    process.env.CONTRACT_FIXTURES_DIR = dir;
    process.env.CONTRACT_FIXTURES_UPDATE = "1";
    try {
      const contract = contractFixtures({ side: "provider" });
      assert.equal(contract.dir, path.resolve(dir));
      assert.equal(contract.update, true);
      assert.equal(contractFixtures({ side: "provider", update: false }).update, false);
      process.env.CONTRACT_FIXTURES_UPDATE = "true";
      assert.equal(contractFixtures({ side: "provider" }).update, false);
    } finally {
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

  it("resetLedger forgets one side only", () => {
    const dir = copyOfContracts();
    contractFixtures({ side: "provider", dir }).readTable("order-total");
    contractFixtures({ side: "consumer", dir }).readTable("order-total");
    resetLedger({ dir, side: "provider" });
    assert.deepEqual(ledgerLines(dir, "provider"), []);
    assert.equal(ledgerLines(dir, "consumer").length, 1);
    resetLedger({ dir, side: "provider" });
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
