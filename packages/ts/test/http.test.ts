import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contractFixtures,
  ContractUsageError,
  exchangeFromTestResponse,
  requestFromFetch,
  resolvePlaceholders,
  toFetchResponse,
  type ExchangeRequest,
} from "../src/index.js";
import { copyOfContracts, tempDir } from "./helpers.js";

describe("toFetchResponse", () => {
  it("gives the status, the headers and the JSON body of a fixture, and nothing else", async () => {
    const response = toFetchResponse({
      status: 409,
      headers: { "content-type": "application/json", "retry-after": "30" },
      body: { error: "out_of_stock", available: 0 },
    });
    assert.equal(response.status, 409);
    assert.equal(response.ok, false);
    assert.deepEqual([...response.headers], [
      ["content-type", "application/json"],
      ["retry-after", "30"],
    ]);
    assert.deepEqual(await response.json(), { error: "out_of_stock", available: 0 });
  });

  it("does not invent a content-type", async () => {
    const response = toFetchResponse({ status: 200, body: { id: "ord_81f3" } });
    assert.deepEqual([...response.headers], []);
    assert.equal(await response.text(), '{"id":"ord_81f3"}');
  });

  it("sends a header with several values once per value", () => {
    const response = toFetchResponse({
      status: 200,
      headers: { "set-cookie": ["<cookie:session-1>", "theme=dark; Path=/"], vary: ["accept", "origin"] },
    });
    assert.deepEqual(response.headers.getSetCookie(), ["<cookie:session-1>", "theme=dark; Path=/"]);
    assert.equal(response.headers.get("vary"), "accept, origin");
  });

  it("has no body when the fixture has none, and keeps bodies that are not objects", async () => {
    assert.equal(toFetchResponse({ status: 204 }).body, null);
    assert.equal(toFetchResponse({ status: 200, body: null }).body, null);
    assert.equal(await toFetchResponse({ status: 200, body: [1, "é"] }).text(), '[1,"é"]');
    assert.equal(await toFetchResponse({ status: 200, body: false }).json(), false);
    assert.equal(await toFetchResponse({ status: 200, body: "" }).json(), "");
  });

  it("reads a fixture after its placeholders were replaced", async () => {
    const contract = contractFixtures({ side: "consumer", dir: copyOfContracts() });
    const fixture = contract.readResponse("order.created");
    const response = toFetchResponse(resolvePlaceholders(fixture.response, () => undefined));
    assert.equal(response.status, 201);
    assert.equal(((await response.json()) as { total_minor: number }).total_minor, 1200);
  });

  it("refuses a header fetch does not accept, without showing its value", () => {
    assert.throws(
      () => toFetchResponse({ status: 200, headers: { "x-note": "line\nbreak-real" } }),
      (error: unknown) => {
        assert.ok(error instanceof ContractUsageError);
        assert.match(error.message, /the header "x-note"/);
        assert.ok(!error.message.includes("break-real"));
        return true;
      },
    );
  });

  it("refuses what a Response cannot be", () => {
    for (const status of [100, 199, 600, 200.5]) {
      assert.throws(() => toFetchResponse({ status }), ContractUsageError, String(status));
    }
    for (const status of [204, 205, 304]) {
      assert.throws(() => toFetchResponse({ status, body: {} }), /cannot have a body/, String(status));
      assert.equal(toFetchResponse({ status }).status, status);
    }
  });
});

describe("requestFromFetch", () => {
  it("reads the arguments of fetch", async () => {
    const request = await requestFromFetch("https://api.example.test/orders?expand=lines#top", {
      method: "post",
      headers: { Authorization: "Bearer real", "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "tea-100", quantity: 2 }),
    });
    assert.deepEqual(request, {
      method: "POST",
      path: "/orders?expand=lines",
      headers: { authorization: "Bearer real", "content-type": "application/json" },
      body: { sku: "tea-100", quantity: 2 },
    });
    assert.deepEqual(Object.keys(request), ["method", "path", "headers", "body"]);
  });

  it("reads a URL object, and a path without an origin", async () => {
    assert.deepEqual(await requestFromFetch(new URL("http://localhost:3000/orders/ord_81f3/receipt")), {
      method: "GET",
      path: "/orders/ord_81f3/receipt",
    });
    assert.deepEqual(await requestFromFetch("/orders?limit=2&after=ord 1"), {
      method: "GET",
      path: "/orders?limit=2&after=ord%201",
    });
  });

  it("reads a Request and leaves it readable", async () => {
    const sent = new Request("https://api.example.test/payments", {
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: '{"order_id":"ord_81f3"}',
    });
    assert.deepEqual(await requestFromFetch(sent), {
      method: "POST",
      path: "/payments",
      headers: { "content-type": "application/json" },
      body: { order_id: "ord_81f3" },
    });
    assert.equal(await sent.text(), '{"order_id":"ord_81f3"}');
  });

  it("lets init win over a Request, as fetch does", async () => {
    const base = new Request("https://api.example.test/orders", { headers: { accept: "application/json" } });
    assert.deepEqual(await requestFromFetch(base, { method: "DELETE" }), {
      method: "DELETE",
      path: "/orders",
      headers: { accept: "application/json" },
    });
  });

  it("records the content-type fetch gives a string body that has none", async () => {
    const request = await requestFromFetch("/orders", { method: "POST", body: "{}" });
    assert.deepEqual(request.headers, { "content-type": "text/plain;charset=UTF-8" });
    assert.deepEqual(request.body, {});
  });

  it("records only the named headers when names are given", async () => {
    const init = { headers: { Authorization: "Bearer real", Accept: "application/json", "X-Trace": "1" } };
    const some = await requestFromFetch("/orders", init, { headers: ["Accept", "if-none-match"] });
    assert.deepEqual(some.headers, { accept: "application/json" });
    const none = await requestFromFetch("/orders", init, { headers: [] });
    assert.equal(Object.hasOwn(none, "headers"), false);
  });

  it("refuses a body that is not JSON, without showing it", async () => {
    await assert.rejects(
      requestFromFetch("/sessions", { method: "POST", body: new URLSearchParams({ password: "hunter2-real" }) }),
      (error: unknown) => {
        assert.ok(error instanceof ContractUsageError);
        assert.match(error.message, /the body of the POST request is not JSON/);
        assert.ok(!error.message.includes("sessions"));
        assert.ok(!error.message.includes("hunter2-real"));
        return true;
      },
    );
  });

  it("does not show a URL it cannot use", async () => {
    for (const url of ["https://user:pw-real@api.example.test/orders", "http://["]) {
      await assert.rejects(requestFromFetch(url), (error: unknown) => {
        assert.ok(error instanceof ContractUsageError);
        assert.ok(!error.message.includes("pw-real"));
        return true;
      });
    }
  });

  it("gives what verifyRequest takes, from a fetch a test put in the place of the real one", async () => {
    const dir = copyOfContracts();
    const contract = contractFixtures({ side: "consumer", dir, update: false });
    const sent: ExchangeRequest[] = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      sent.push(await requestFromFetch(input, init));
      return toFetchResponse(contract.readResponse("order.created").response);
    };

    // The client code under test.
    const response = await fakeFetch("https://api.example.test/orders", {
      method: "POST",
      headers: { Authorization: "<token:customer-1>", "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "tea-100", quantity: 2 }),
    });
    assert.equal(response.status, 201);

    // The stored fixture of the shared contracts is this request.
    contract.verifyRequest({
      name: "create-order.request",
      description: "The request the client sends to place an order",
      request: sent[0]!,
    });
    sent[0]!.path = "/orders?dry_run=1";
    assert.throws(
      () => contract.verifyRequest({ name: "create-order.request", description: "x", request: sent[0]! }),
      /request.path: "\/orders" -> "\/orders\?dry_run=1"/,
    );
  });
});

/** Runs `body` with stand-ins in the global scope, and puts the real classes back. */
async function withGlobals(standIns: Record<string, unknown>, body: () => unknown): Promise<void> {
  const scope = globalThis as Record<string, unknown>;
  const real = Object.fromEntries(Object.keys(standIns).map((name) => [name, scope[name]]));
  Object.assign(scope, standIns);
  try {
    await body();
  } finally {
    Object.assign(scope, real);
  }
}

describe("a test environment without the fetch classes of the standard", () => {
  const fixture = { status: 422, headers: { "content-type": "application/json" }, body: { error: "invalid" } };
  const refused = (helper: string, fault: string) => (error: unknown) => {
    assert.ok(error instanceof ContractUsageError);
    assert.ok(error.message.startsWith(`contract-fixtures: ${helper} needs the `), error.message);
    assert.ok(error.message.includes(`(${fault})`), error.message);
    assert.match(error.message, /Run this test file in the Node\.js environment/);
    assert.doesNotMatch(error.message, /invalid|application\/json/);
    return true;
  };

  it("refuses a stand-in Response that keeps the body and nothing else", async () => {
    // The few lines a project writes when its test environment has no Response.
    class StandIn {
      constructor(
        private readonly content: unknown,
        readonly init: unknown,
      ) {}
      json(): Promise<unknown> {
        return Promise.resolve(this.content);
      }
    }
    await withGlobals({ Response: StandIn }, () => {
      assert.throws(() => toFetchResponse(fixture), refused("toFetchResponse", "its status is not the 422 it was made with"));
    });
  });

  it("refuses a stand-in Response for each thing that is not as the standard says", async () => {
    const real = Response;
    const standIn = (change: (response: Record<string, unknown>) => void): unknown =>
      function (this: unknown, bytes: Uint8Array | null, init: ResponseInit) {
        const made = new real(bytes, init);
        const copy: Record<string, unknown> = {
          status: made.status,
          ok: made.ok,
          bodyUsed: false,
          headers: made.headers,
          json: () => made.json(),
          text: () => made.text(),
          clone: () => made.clone(),
        };
        change(copy);
        return copy;
      };
    const cases: [string, (response: Record<string, unknown>) => void][] = [
      ["its ok is not false", (r) => delete r.ok],
      ["its ok is not false", (r) => (r.ok = true)],
      ["it lacks json, text or clone", (r) => delete r.text],
      ["its bodyUsed is not false before the body was read", (r) => (r.bodyUsed = true)],
      ["its headers have no get", (r) => (r.headers = { "content-type": "application/json" })],
      ['its headers do not give "content-type" back', (r) => (r.headers = new Headers())],
    ];
    for (const [fault, change] of cases) {
      await withGlobals({ Response: standIn(change) }, () => {
        assert.throws(() => toFetchResponse(fixture), refused("toFetchResponse", fault));
      });
    }
    await withGlobals({ Response: standIn(() => {}) }, () => {
      assert.equal(toFetchResponse(fixture).status, 422);
    });
  });

  it("refuses a Response that cannot be made, and an environment that has none", async () => {
    const throwing = function (): never {
      throw new TypeError("not a constructor of the standard");
    };
    await withGlobals({ Response: throwing }, () => {
      assert.throws(
        () => toFetchResponse(fixture),
        refused("toFetchResponse", "it cannot be made from bytes, a status and Headers"),
      );
    });
    for (const missing of [{ Response: undefined }, { Headers: undefined }]) {
      await withGlobals(missing, () => {
        assert.throws(() => toFetchResponse(fixture), refused("toFetchResponse", "there is no global Response or Headers"));
      });
    }
    await withGlobals({ Headers: class {} }, () => {
      assert.throws(() => toFetchResponse(fixture), refused("toFetchResponse", "its Headers have no append"));
    });
  });

  it("still gives the real Response of Node.js, for every status and header of a fixture", async () => {
    for (const status of [200, 204, 301, 404, 500]) {
      const response = toFetchResponse({
        status,
        headers: { "set-cookie": ["a=1", " b=2 "], "x-note": "\t padded " },
        ...(status === 204 ? {} : { body: { status } }),
      });
      assert.ok(response instanceof Response);
      assert.equal(response.headers.get("x-note"), "padded");
      assert.equal(response.ok, status === 200 || status === 204);
      if (status !== 204) assert.deepEqual(await response.json(), { status });
    }
  });

  it("still reads what the real Request of Node.js makes of unusual arguments", async () => {
    assert.deepEqual(
      await requestFromFetch("https://api.example.test/a%20b/../orders?q=1#part", { method: "patch", body: '"\ud800"' }),
      { method: "patch", path: "/orders?q=1", headers: { "content-type": "text/plain;charset=UTF-8" }, body: "\ufffd" },
    );
    const request = new Request("https://api.example.test/orders", { method: "PUT", body: "{}" });
    assert.equal((await requestFromFetch(request, { method: "delete", body: undefined })).method, "DELETE");
    assert.equal(toFetchResponse({ status: 200, headers: { "X-Note": "a", "x-note": "b" } }).headers.get("x-note"), "a, b");
  });

  it("refuses a stand-in Request, and an environment that has none", async () => {
    const real = Request;
    const standIn = (change: (request: Record<string, unknown>) => void): unknown =>
      function (this: unknown, input: string | URL | Request, init?: RequestInit) {
        const made = new real(input, init);
        const copy: Record<string, unknown> = {
          url: made.url,
          method: made.method,
          headers: made.headers,
          text: () => made.text(),
        };
        change(copy);
        return copy;
      };
    const init = { method: "post", headers: { authorization: "Bearer invalid" }, body: '{"sku":"tea-100"}' };
    const cases: [string, (request: Record<string, unknown>) => void][] = [
      ["it lacks url or method", (r) => delete r.method],
      ["it lacks text", (r) => delete r.text],
      ["its headers have no forEach", (r) => (r.headers = { authorization: "Bearer invalid" })],
      ["its url is not the one it was made with", (r) => (r.url = "/orders")],
      ["its method is not the one it was made with", (r) => (r.method = "GET")],
      ["its text is not the body it was made with", (r) => (r.text = () => Promise.resolve(""))],
      ["its text is not the body it was made with", (r) => (r.text = () => Promise.resolve(undefined))],
    ];
    for (const [fault, change] of cases) {
      await withGlobals({ Request: standIn(change) }, async () => {
        await assert.rejects(requestFromFetch("https://api.example.test/orders", init), refused("requestFromFetch", fault));
      });
    }
    await withGlobals({ Request: standIn(() => {}) }, async () => {
      assert.equal((await requestFromFetch("https://api.example.test/orders", init)).method, "POST");
    });
    await withGlobals({ Request: undefined }, async () => {
      await assert.rejects(requestFromFetch("/orders"), refused("requestFromFetch", "there is no global Request"));
    });
  });
});

describe("exchangeFromTestResponse", () => {
  /** The shape of the response object of an HTTP test client. */
  const testResponse = () => ({
    status: 201,
    statusCode: 201,
    headers: {
      "content-type": "application/json",
      "set-cookie": ["a=1; Path=/", "b=2"],
      date: "Thu, 15 Jan 2026 09:30:00 GMT",
      connection: "close",
      "content-length": "35",
    },
    body: { id: "ord_81f3", status: "confirmed" },
    text: '{"id":"ord_81f3","status":"confirmed"}',
    request: {
      method: "POST",
      url: "http://127.0.0.1:61390/orders?expand=lines",
      header: { Authorization: "Bearer real", "Content-Type": "application/json" },
      _data: { sku: "tea-100", quantity: 2 },
    },
  });

  it("takes the method, the path and the status, and no header that was not named", () => {
    assert.deepEqual(exchangeFromTestResponse(testResponse()), {
      request: { method: "POST", path: "/orders?expand=lines" },
      response: { status: 201, body: { id: "ord_81f3", status: "confirmed" } },
    });
  });

  it("takes the named headers of both sides, whatever case they are named in", () => {
    const exchange = exchangeFromTestResponse(testResponse(), {
      requestHeaders: ["authorization", "x-absent"],
      responseHeaders: ["Content-Type", "set-cookie", "retry-after"],
      request: { body: { sku: "tea-100", quantity: 2 } },
    });
    assert.deepEqual(exchange, {
      request: {
        method: "POST",
        path: "/orders?expand=lines",
        headers: { authorization: "Bearer real" },
        body: { sku: "tea-100", quantity: 2 },
      },
      response: {
        status: 201,
        headers: { "content-type": "application/json", "set-cookie": ["a=1; Path=/", "b=2"] },
        body: { id: "ord_81f3", status: "confirmed" },
      },
    });
  });

  it("has no body for an empty response, although the client gives {}", () => {
    const exchange = exchangeFromTestResponse({ ...testResponse(), status: 204, body: {}, text: "" });
    assert.deepEqual(exchange.response, { status: 204 });
  });

  it("lets the test pass what the object does not hold, and what the test passes wins", () => {
    const exchange = exchangeFromTestResponse(
      { statusCode: 200, headers: new Headers([["Content-Type", "text/csv"], ["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]]), body: "a,b\n" },
      {
        responseHeaders: ["content-type", "set-cookie"],
        request: { method: "GET", path: "/orders.csv", headers: { accept: "text/csv" } },
        response: { body: undefined, status: 206 },
      },
    );
    assert.deepEqual(exchange, {
      request: { method: "GET", path: "/orders.csv", headers: { accept: "text/csv" } },
      response: { status: 206, headers: { "content-type": "text/csv", "set-cookie": ["a=1", "b=2"] }, body: "a,b\n" },
    });
    const withoutBody = exchangeFromTestResponse(
      { status: 200, body: "a,b\n", req: { method: "GET", path: "/orders.csv" } },
      { response: { body: null } },
    );
    assert.deepEqual(withoutBody.response, { status: 200, body: null });
  });

  it("reads a request that has `path` and `headers`, and numbers as header values", () => {
    const exchange = exchangeFromTestResponse(
      { status: 200, req: { method: "GET", path: "/orders?limit=2", headers: { "content-length": 17 } } },
      { requestHeaders: ["content-length"] },
    );
    assert.deepEqual(exchange.request, { method: "GET", path: "/orders?limit=2", headers: { "content-length": "17" } });
  });

  it("refuses the {} a client gives for a body that is not JSON, unless the test says what to record", () => {
    const html = { ...testResponse(), status: 502, body: {}, text: "<html>Bad Gateway</html>" };
    assert.throws(() => exchangeFromTestResponse(html), /has a text that is not JSON, and an empty object as its body/);
    assert.deepEqual(exchangeFromTestResponse(html, { response: { body: null } }).response, { status: 502, body: null });
    assert.deepEqual(exchangeFromTestResponse(html, { response: { body: html.text } }).response.body, html.text);
    // A body that really is {} is one.
    assert.deepEqual(exchangeFromTestResponse({ ...testResponse(), body: {}, text: " {} " }).response.body, {});
  });

  it("takes each part of the request from the object that has it, and a path a test passes as it is", () => {
    const exchange = exchangeFromTestResponse({ status: 200, request: { header: { accept: "a/b" } }, req: { method: "GET", path: "/orders" } }, { requestHeaders: ["accept"] });
    assert.deepEqual(exchange.request, { method: "GET", path: "/orders", headers: { accept: "a/b" } });
    const passed = exchangeFromTestResponse({ status: 200, request: { method: "GET", url: "http://[" } }, { request: { path: "/orders" } });
    assert.equal(passed.request.path, "/orders");
    assert.throws(() => exchangeFromTestResponse({ status: 200, request: { method: "GET", url: "http://[" } }), /does not show request.path;/);
    assert.throws(() => exchangeFromTestResponse({ status: Number.NaN, request: { method: "GET", url: "/a" } }), /response.status/);
  });

  it("says what is lacking", () => {
    assert.throws(
      () => exchangeFromTestResponse({ body: {} }),
      /does not show request.method, request.path, response.status; pass it in the options/,
    );
    assert.throws(() => exchangeFromTestResponse(null), ContractUsageError);
    assert.throws(
      () => exchangeFromTestResponse({ status: 200 }, { request: { method: "GET" } }),
      /does not show request.path;/,
    );
  });

  it("gives what verifyResponse takes, and secrets are replaced there", () => {
    const dir = tempDir();
    const contract = contractFixtures({ side: "provider", dir, update: true });
    contract.verifyResponse({
      name: "order.created",
      description: "An order is accepted",
      ...exchangeFromTestResponse(testResponse(), {
        requestHeaders: ["authorization"],
        responseHeaders: ["set-cookie"],
        request: { body: { sku: "tea-100", quantity: 2 } },
      }),
      secret: {
        "request.headers.authorization": "<token:customer-1>",
        "response.headers.set-cookie.0": "<cookie:session-1>",
      },
    });
    const stored = contractFixtures({ side: "consumer", dir }).readResponse("order.created");
    assert.deepEqual(stored.request.headers, { authorization: "<token:customer-1>" });
    assert.deepEqual(stored.response.headers, { "set-cookie": ["<cookie:session-1>", "b=2"] });
  });
});
