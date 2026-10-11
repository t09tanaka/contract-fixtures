/**
 * The consumer side of the contract, for the web client.
 *
 * The client calls `fetch`. These tests give it a `fetch` that answers with a fixture and
 * keeps the request, so the client's own code builds the request and decodes the response.
 *
 * - provider fixtures (../contracts-web/provider/, verified by the provider's tests): what the
 *   client makes of the responses the API really gave.
 * - consumer fixtures (../contracts-web/consumer/): the requests the client really sends; the
 *   provider's tests send them to the real server.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contractFixtures,
  requestFromFetch,
  resolvePlaceholders,
  toFetchResponse,
  type ExchangeRequest,
} from "@t09tanaka/contract-fixtures";

import { createOrdersClient } from "../src/orders-client.js";

const contract = contractFixtures({ side: "consumer", dir: "../contracts-web" });

/** A client whose `fetch` answers with the fixture `name`; `sent` collects what it sends. */
function clientAnsweredBy(name: string) {
  const sent: ExchangeRequest[] = [];
  const client = createOrdersClient({
    baseUrl: "https://api.example.test",
    authorization: "Bearer token-of-the-web-test",
    fetch: async (input, init) => {
      sent.push(await requestFromFetch(input, init));
      const { response } = contract.readResponse(name);
      return toFetchResponse(resolvePlaceholders(response, (kind, id) => `test ${kind} of ${id}`));
    },
  });
  return { client, sent };
}

/** Fixture name -> what the client must make of that response to "place an order". */
const orderExpectations: Record<string, string> = {
  "order.created": "placed, total 1200",
  "order.out-of-stock": "out of stock, 0 left",
  "order.token-invalid": "sign in again",
};

/** The same for the receipt, where the response headers are a part of the agreement. */
const receiptExpectations: Record<string, string> = {
  "receipt.downloaded": "save receipt-<order id>.json, total 1200",
};

describe("provider fixtures: what the client makes of real responses", () => {
  it("every provider fixture belongs to one of the tables", () => {
    contract.assertPrefixesCover("provider", ["order.", "receipt."]);
  });

  it("every order fixture has an expectation here", () => {
    contract.assertCovers("provider", Object.keys(orderExpectations), { prefix: "order." });
  });

  for (const [name, expected] of Object.entries(orderExpectations)) {
    it(name, async () => {
      const outcome = await clientAnsweredBy(name).client.placeOrder("tea-100", 2);

      const text = {
        placed: () => `placed, total ${outcome.kind === "placed" ? outcome.totalMinor : ""}`,
        "out-of-stock": () => `out of stock, ${outcome.kind === "out-of-stock" ? outcome.available : ""} left`,
        "sign-in-again": () => "sign in again",
        failed: () => "failed",
      }[outcome.kind]();
      assert.equal(text, expected);
    });
  }

  it("every receipt fixture has an expectation here", () => {
    contract.assertCovers("provider", Object.keys(receiptExpectations), { prefix: "receipt." });
  });

  for (const [name, expected] of Object.entries(receiptExpectations)) {
    it(name, async () => {
      const outcome = await clientAnsweredBy(name).client.downloadReceipt("ord_demo1");

      // The file name holds the id of the order the provider's test happened to place.
      const text =
        outcome.kind === "ready"
          ? `save ${outcome.fileName.replace(/ord_[a-z0-9]+/, "<order id>")}, total ${outcome.totalMinor}`
          : outcome.kind;
      assert.equal(text, expected);
    });
  }
});

describe("consumer fixtures: the requests the client really sends", () => {
  /** The client was given a real-looking token; the fixture gets the placeholder. */
  const secret = { "request.headers.authorization": "<token:customer-1>" };

  it("place-order.request", async () => {
    const { client, sent } = clientAnsweredBy("order.created");
    await client.placeOrder("tea-100", 1);

    assert.equal(sent.length, 1);
    contract.verifyRequest({
      name: "place-order.request",
      description: "The request the web client sends to place an order",
      request: sent[0]!,
      secret,
    });
  });

  it("download-receipt.request", async () => {
    const { client, sent } = clientAnsweredBy("receipt.downloaded");
    await client.downloadReceipt("ord_demo1");

    assert.equal(sent.length, 1);
    contract.verifyRequest({
      name: "download-receipt.request",
      description: "The request the web client sends to download the receipt of an order",
      request: sent[0]!,
      secret,
    });
  });
});
