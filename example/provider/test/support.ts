/**
 * What the contract tests of the provider share.
 *
 * - The tests reach the API over HTTP, through the server the entry point starts
 *   (`assembleServer`), with an HTTP test client. Nothing between the client and the handler is
 *   replaced, so a fixture holds what the deployed API answers.
 * - The API has two readers, and each has a contracts directory of its own: the app (Dart,
 *   `../contracts`) and the web client (TypeScript, `../contracts-web`). A response that both
 *   depend on is verified into both directories.
 */
import assert from "node:assert/strict";

import request from "supertest";

import {
  contractFixtures,
  exchangeFromTestResponse,
  resolvePlaceholders,
  type ContractFixtures,
  type ExchangeRequest,
  type VolatileEntry,
} from "@t09tanaka/contract-fixtures";

import { assembleServer } from "../src/server.js";

export type Reader = "app" | "web";

export const contracts: Record<Reader, ContractFixtures> = {
  app: contractFixtures({ side: "provider", dir: "../contracts" }),
  web: contractFixtures({ side: "provider", dir: "../contracts-web" }),
};

/** The real value behind each placeholder that fixtures use instead of a secret. */
const SECRETS: Record<string, string> = { "token:customer-1": "Bearer test-token-of-customer-1" };
export const TOKEN = SECRETS["token:customer-1"]!;

/** A fresh server, assembled the way the entry point assembles it. */
export const api = () => request(assembleServer({ tokens: { "test-token-of-customer-1": "customer-1" } }));

export interface Call {
  method: "GET" | "POST";
  path: string;
  /** The real value: it goes to the API, and `secret` keeps it out of the fixture. */
  authorization?: string;
  body?: object;
}

export interface Scenario {
  name: string;
  description: string;
  /** The readers that depend on this response. */
  readers: Reader[];
  call: Call;
  /** Response headers that are part of the agreement. */
  responseHeaders?: string[];
  volatile?: VolatileEntry[];
  /** Where the response holds a secret, and the placeholder the fixture stores instead. */
  secret?: Record<string, string>;
}

export async function send(client: ReturnType<typeof api>, call: Call): Promise<request.Response> {
  const sending = call.method === "GET" ? client.get(call.path) : client.post(call.path);
  if (call.authorization !== undefined) void sending.set("authorization", call.authorization);
  return call.body === undefined ? await sending : await sending.send(call.body);
}

/** Verifies a response of the API into the directory of every reader that depends on it. */
export function verify(scenario: Scenario, res: request.Response): void {
  // No scenario here expects a 5xx. One would come from a test application that differs
  // from the deployed one, and must fail the test before it can become a fixture.
  assert.ok(res.status < 500, `${scenario.name}: the status ${res.status} is not a response to record`);
  const exchange = exchangeFromTestResponse(res, {
    requestHeaders: ["authorization"],
    responseHeaders: scenario.responseHeaders,
    // The test client does not show the body it sent.
    request: { body: scenario.call.body },
  });
  // The token of customer-1 is a credential; a token the API rejects is not.
  const token: Record<string, string> =
    scenario.call.authorization === TOKEN ? { "request.headers.authorization": "<token:customer-1>" } : {};
  for (const reader of scenario.readers) {
    contracts[reader].verifyResponse({
      name: scenario.name,
      description: scenario.description,
      ...exchange,
      volatile: scenario.volatile,
      secret: { ...token, ...scenario.secret },
    });
  }
}

/** Sends a request a consumer recorded, with real values in the place of its placeholders. */
export async function replay(recorded: ExchangeRequest): Promise<request.Response> {
  const { method, path, headers, body } = resolvePlaceholders(recorded, (kind, name) => SECRETS[`${kind}:${name}`]);
  const sending = method === "GET" ? api().get(path) : api().post(path);
  // A header the client sends more than once reaches the server as one joined value.
  for (const [name, value] of Object.entries(headers ?? {})) void sending.set(name, [value].flat().join(", "));
  return body === undefined ? await sending : await sending.send(body as object);
}

export const ORDER_ID = "^ord_[a-z0-9]+$";
