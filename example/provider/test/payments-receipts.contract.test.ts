/**
 * The provider side of the contract, for payments (a response with a secret in it) and
 * receipts (a response whose headers are part of the agreement).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { api, contracts, ORDER_ID, send, TOKEN, verify, type Scenario } from "./support.js";

const startPayment: Scenario = {
  name: "payment.started",
  description: "Starting the payment of an order returns the key that confirms it",
  readers: ["app"],
  call: { method: "POST", path: "/payments", authorization: TOKEN, body: { order_id: "ord_demo1" } },
  volatile: [{ path: "response.body.id", pattern: "^pay_[a-z0-9]+$" }],
  secret: { "response.body.confirm_key": "<key:payment-1>" },
};

describe("provider fixtures: real responses to payments and receipts", () => {
  it("payment.started", async () => {
    const res = await send(api(), startPayment.call);
    const key = (res.body as { confirm_key: string }).confirm_key;
    assert.match(key, /^[A-Za-z0-9_-]{32}$/);

    verify(startPayment, res);

    // Neither the key the API really returned nor the real token is in a file of a contracts directory.
    for (const contract of Object.values(contracts)) {
      const files = fs.readdirSync(contract.dir, { recursive: true, withFileTypes: true });
      for (const entry of files.filter((e) => e.isFile())) {
        const text = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
        assert.ok(!text.includes(key), `${entry.name} holds the real key`);
        assert.ok(!text.includes(TOKEN), `${entry.name} holds the real token`);
      }
    }
  });

  it("receipt.downloaded", async () => {
    // The id of the order is new on every run, and it is a part of the path of the request.
    const client = api();
    const placed = await send(client, {
      method: "POST",
      path: "/orders",
      authorization: TOKEN,
      body: { sku: "tea-100", quantity: 2 },
    });
    const orderId = (placed.body as { id: string }).id;
    const scenario: Scenario = {
      name: "receipt.downloaded",
      description: "The receipt of an order is a download with a file name",
      readers: ["app", "web"],
      call: { method: "GET", path: `/orders/${orderId}/receipt`, authorization: TOKEN },
      responseHeaders: ["content-type", "content-disposition", "cache-control"],
      volatile: [
        { path: "request.path", pattern: "^/orders/ord_[a-z0-9]+/receipt$" },
        { path: "response.body.order_id", pattern: ORDER_ID },
        {
          path: "response.headers.content-disposition",
          pattern: '^attachment; filename="receipt-ord_[a-z0-9]+\\.json"$',
        },
      ],
    };

    verify(scenario, await send(client, scenario.call));
  });
});
