/**
 * The provider side of the contract.
 *
 * - provider fixtures: call the real handler and verify the real response against
 *   ../contracts/provider/<name>.json (the consumer's tests read those files).
 * - consumer fixtures: pass the requests the consumer really builds to the real handler.
 * - tables: run the shared rows through this side's calculation.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { contractFixtures, resolvePlaceholders } from "@t09tanaka/contract-fixtures";

import { createApp, orderTotalMinor, type HttpRequest } from "../src/orders.js";

const contract = contractFixtures({ side: "provider", dir: "../contracts" });

/** The real value behind each placeholder that fixtures use instead of a secret. */
const SECRETS: Record<string, string> = { "token:customer-1": "Bearer test-token-of-customer-1" };
const app = () => createApp({ tokens: { "test-token-of-customer-1": "customer-1" } });
const withSecrets = <T>(value: T): T =>
  resolvePlaceholders(value, (kind, name) => SECRETS[`${kind}:${name}`]);

const authorized = { authorization: "<token:customer-1>" };

interface Scenario {
  name: string;
  description: string;
  request: HttpRequest;
  volatile?: string[];
  /** Where the response holds a secret, and the placeholder the fixture stores instead. */
  secret?: Record<string, string>;
}

const order = (body: unknown, headers: Record<string, string> = authorized): HttpRequest => ({
  method: "POST",
  path: "/orders",
  headers,
  body,
});

const startPayment: Scenario = {
  name: "payment.started",
  description: "Starting the payment of an order returns the key that confirms it",
  request: { method: "POST", path: "/payments", headers: authorized, body: { order_id: "ord_demo1" } },
  volatile: ["response.body.id"],
  secret: { "response.body.confirm_key": "<key:payment-1>" },
};

const scenarios: Scenario[] = [
  {
    name: "order.created",
    description: "An order is accepted",
    request: order({ sku: "tea-100", quantity: 2 }),
    volatile: ["response.body.id", "response.body.created_at"],
  },
  {
    name: "order.created-with-coupon",
    description: "An order with a valid coupon is accepted at the discounted total",
    request: order({ sku: "tin-300", quantity: 1, coupon: "SAVE10" }),
    volatile: ["response.body.id", "response.body.created_at"],
  },
  {
    name: "order.out-of-stock",
    description: "There are fewer items in stock than were ordered",
    request: order({ sku: "mug-200", quantity: 1 }),
  },
  {
    name: "order.coupon-unknown",
    description: "The coupon code does not exist",
    request: order({ sku: "tea-100", quantity: 1, coupon: "NOPE" }),
  },
  {
    name: "order.invalid-quantity",
    description: "The quantity is not a positive integer",
    request: order({ sku: "tea-100", quantity: 0 }),
  },
  {
    name: "order.token-invalid",
    description: "The token is expired or was never issued",
    request: order({ sku: "tea-100", quantity: 1 }, { authorization: "Bearer expired" }),
  },
  startPayment,
];

describe("provider fixtures: real responses", () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const response = app().handle(withSecrets(scenario.request));

      contract.verifyResponse({
        name: scenario.name,
        description: scenario.description,
        request: scenario.request,
        response,
        volatile: scenario.volatile,
        secret: scenario.secret,
      });
    });
  }

  it("payment.started: the key the API really returned is in no file of the contracts directory", () => {
    const response = app().handle(withSecrets(startPayment.request));
    const key = (response.body as { confirm_key: string }).confirm_key;
    assert.match(key, /^[A-Za-z0-9_-]{32}$/);

    contract.verifyResponse({ ...startPayment, response });

    const files = fs.readdirSync(contract.dir, { recursive: true, withFileTypes: true });
    for (const entry of files.filter((e) => e.isFile())) {
      const text = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
      assert.ok(!text.includes(key), `${entry.name} holds the real key`);
    }
  });

  it("scenario names are unique", () => {
    const names = scenarios.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("consumer fixtures: requests the client really builds", () => {
  /** What the handler must answer to each request the consumer recorded. */
  const expectations: Record<string, { status: number; totalMinor: number }> = {
    "create-order.request": { status: 201, totalMinor: 1200 },
    "create-order.with-coupon.request": { status: 201, totalMinor: 899 },
  };

  it("every consumer fixture has an expectation here", () => {
    contract.assertCovers("consumer", Object.keys(expectations));
  });

  for (const [name, expected] of Object.entries(expectations)) {
    it(name, () => {
      const { request } = contract.readRequest(name);

      const response = app().handle(
        withSecrets({
          method: request.method,
          path: request.path,
          headers: request.headers ?? {},
          body: request.body,
        }),
      );

      assert.equal(response.status, expected.status);
      assert.equal((response.body as { total_minor: number }).total_minor, expected.totalMinor);
    });
  }
});

describe("table: order-total", () => {
  interface Row {
    case: string;
    unit_price_minor: number;
    quantity: number;
    discount_percent: number;
    expected_minor: number;
  }
  for (const row of contract.readTable<Row>("order-total").rows) {
    it(row.case, () => {
      assert.equal(
        orderTotalMinor(row.unit_price_minor, row.quantity, row.discount_percent),
        row.expected_minor,
      );
    });
  }
});
