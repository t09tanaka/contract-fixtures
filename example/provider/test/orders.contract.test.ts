/**
 * The provider side of the contract, for placing an order.
 *
 * - provider fixtures: send a request to the real server and verify the real response against
 *   provider/<name>.json (the tests of the readers read those files).
 * - consumer fixtures: send the requests the readers really build to the real server.
 * - tables: run the shared rows through this side's calculation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { orderTotalMinor } from "../src/orders.js";
import { api, contract, ORDER_ID, replay, send, TOKEN, verify, type Scenario } from "./support.js";

const order = (body: object, authorization: string = TOKEN) =>
  ({ method: "POST", path: "/orders", authorization, body }) as const;

/**
 * Values that change on every run. Each one is named as narrowly as possible, with the shape
 * it must keep, so that everything around it is still compared exactly.
 */
const anOrderId = { path: "response.body.id", pattern: ORDER_ID };
const A_TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
/** Wherever a `created_at` appears in the body, at any depth. */
const anyCreatedAt = { path: "response.body.**.created_at", pattern: A_TIME };
/**
 * A time in an order with a coupon, null in one without. The same entry serves both: with
 * `nullable`, the value is a string of this shape or null, and nothing else.
 */
const aRedemptionTime = { path: "response.body.coupon_redeemed_at", pattern: A_TIME, nullable: true } as const;

const scenarios: Scenario[] = [
  {
    name: "order.created",
    description: "An order is accepted",
    call: order({ sku: "tea-100", quantity: 2 }),
    volatile: [anOrderId, anyCreatedAt, aRedemptionTime],
  },
  {
    name: "order.created-with-coupon",
    description: "An order with a valid coupon is accepted at the discounted total",
    call: order({ sku: "tin-300", quantity: 1, coupon: "SAVE10" }),
    volatile: [anOrderId, anyCreatedAt, aRedemptionTime],
  },
  {
    name: "order.out-of-stock",
    description: "There are fewer items in stock than were ordered",
    call: order({ sku: "mug-200", quantity: 1 }),
  },
  {
    name: "order.coupon-unknown",
    description: "The coupon code does not exist",
    call: order({ sku: "tea-100", quantity: 1, coupon: "NOPE" }),
  },
  {
    name: "order.invalid-quantity",
    description: "The quantity is not a positive integer",
    call: order({ sku: "tea-100", quantity: 0 }),
  },
  {
    name: "order.token-invalid",
    description: "The token is expired or was never issued",
    call: order({ sku: "tea-100", quantity: 1 }, "Bearer expired"),
  },
];

describe("provider fixtures: real responses to placing an order", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      verify(scenario, await send(api(), scenario.call));
    });
  }

  it("order.body-not-json", async () => {
    // Answered by the server before the handler is reached, so only a test that comes in
    // over HTTP can record it. The body that was sent is not JSON and is left out.
    const res = await api()
      .post("/orders")
      .set("authorization", TOKEN)
      .set("content-type", "application/json")
      .send('{"sku": "tea-100", "quantity": ');

    verify(
      {
        name: "order.body-not-json",
        description: "The body of the request is not JSON",
        call: { method: "POST", path: "/orders", authorization: TOKEN },
        responseHeaders: ["content-type"],
      },
      res,
    );
  });

  it("scenario names are unique", () => {
    const names = scenarios.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("consumer fixtures: requests the readers really build", () => {
  /** What the server must answer to each request a reader recorded. The name starts with the reader. */
  const expectations: Record<string, { status: number; totalMinor: number }> = {
    "app.create-order.request": { status: 201, totalMinor: 1200 },
    "app.create-order.with-coupon.request": { status: 201, totalMinor: 899 },
    "web.place-order.request": { status: 201, totalMinor: 600 },
    "web.download-receipt.request": { status: 200, totalMinor: 1200 },
  };

  it("no request of a reader is left without an expectation", () => {
    contract.assertCovers("consumer", Object.keys(expectations));
  });

  for (const [name, expected] of Object.entries(expectations)) {
    it(name, async () => {
      const res = await replay(contract.readRequest(name).request);

      assert.equal(res.status, expected.status);
      assert.equal((res.body as { total_minor: number }).total_minor, expected.totalMinor);
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
