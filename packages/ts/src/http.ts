/**
 * Glue between fixtures and the two places tests usually meet HTTP: the standard `fetch`
 * (`Request`, `Response`, `Headers`) on the consumer side, and the response object of an HTTP
 * test client on the provider side. Nothing here depends on a library; the test client is
 * read by the shape of its objects.
 */
import { Buffer } from "node:buffer";

import { ContractUsageError } from "./errors.js";
import { asciiLowerCase } from "./json.js";
import type { ExchangeRequest, ExchangeResponse } from "./types.js";

type HeaderMap = Record<string, string | string[]>;

/** Statuses a `Response` cannot carry a body with. */
const NO_BODY_STATUS: readonly number[] = [204, 205, 304];

/**
 * A standard `Response` with the status, the headers and the body of a fixture, to return
 * from a `fetch` that a test put in the place of the real one. The client code under test
 * then reads a real `Response`: it checks `ok` and `status`, reads headers, and decodes JSON
 * itself.
 *
 * Only what the fixture holds is in the `Response`. There is no `content-type` unless the
 * provider's test recorded one: a client that looks at the header depends on it, so the
 * header belongs in the fixture. A header with an array of values is sent once per value.
 *
 * Replace placeholders first: `toFetchResponse(resolvePlaceholders(fixture.response, ...))`.
 */
export function toFetchResponse(response: ExchangeResponse): Response {
  const { status, body } = response;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new ContractUsageError(
      `contract-fixtures: a Response cannot have the status ${status} (fetch only gives 200 to 599)`,
    );
  }
  const hasBody = body !== undefined && body !== null;
  if (hasBody && NO_BODY_STATUS.includes(status)) {
    throw new ContractUsageError(
      `contract-fixtures: a Response with the status ${status} cannot have a body, but the fixture has one`,
    );
  }
  const scope = globalThis as { Headers?: unknown; Response?: unknown };
  if (typeof scope.Headers !== "function" || typeof scope.Response !== "function") {
    throw notStandard("toFetchResponse", "Response", "there is no global Response or Headers");
  }
  const headers = new Headers();
  if (typeof (headers as Partial<Headers>).append !== "function") {
    throw notStandard("toFetchResponse", "Response", "its Headers have no append");
  }
  const expected = new Map<string, string>();
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      try {
        headers.append(name, item);
      } catch {
        // The value is not shown: it may be a credential.
        throw new ContractUsageError(
          `contract-fixtures: a Response cannot have the header ${JSON.stringify(name)} of the fixture ` +
            "(the name or the value is not one fetch accepts)",
        );
      }
    }
    // What `get` of the standard gives: the values without the white space around them, joined.
    if (items.every((item) => typeof item === "string")) {
      expected.set(name, items.map((item) => item.replace(/^[\t ]+|[\t ]+$/g, "")).join(", "));
    }
  }
  // Bytes, not a string: a string would make the Response invent `content-type: text/plain`.
  // From node:buffer, because a browser-like test environment may have no TextEncoder.
  const bytes = hasBody ? Buffer.from(JSON.stringify(body), "utf8") : null;
  let made: Response;
  try {
    made = new Response(bytes, { status, headers });
  } catch {
    throw notStandard("toFetchResponse", "Response", "it cannot be made from bytes, a status and Headers");
  }
  const lacking = responseFault(made, status, expected);
  if (lacking !== null) throw notStandard("toFetchResponse", "Response", lacking);
  return made;
}

/**
 * The error for a `Response` or a `Request` that is not the one of the standard. Some test
 * environments have none, and a project then puts a stand-in of a few lines into the global
 * scope. A fixture answered through such a stand-in reaches the client code as something
 * else (no `ok`, no headers, another body), and a test of an error response can pass without
 * having checked anything. So a stand-in is refused, with the way out.
 */
function notStandard(helper: string, name: "Response" | "Request", fault: string): ContractUsageError {
  return new ContractUsageError(
    `contract-fixtures: ${helper} needs the ${name} of the fetch standard, and the one of this test ` +
      `environment is not (${fault}). Run this test file in the Node.js environment of the test runner, ` +
      "or give the test environment the fetch, Request, Response and Headers of Node.js instead of a stand-in " +
      '(see "Test environments without the fetch classes" in the README of the package).',
  );
}

/**
 * What shows that `made` is not a `Response` of the standard for this status and these
 * headers, or `null`. Only what can be seen without reading the body, which would use it up.
 * Header values are not shown: they may be credentials.
 */
function responseFault(made: Response, status: number, headers: ReadonlyMap<string, string>): string | null {
  const like = made as Partial<Response> | null;
  if (typeof like !== "object" || like === null) return "it gives no object";
  if (like.status !== status) return `its status is not the ${status} it was made with`;
  if (like.ok !== (status >= 200 && status <= 299)) return `its ok is not ${status >= 200 && status <= 299}`;
  if (typeof like.json !== "function" || typeof like.text !== "function" || typeof like.clone !== "function") {
    return "it lacks json, text or clone";
  }
  if (like.bodyUsed !== false) return "its bodyUsed is not false before the body was read";
  if (typeof like.headers?.get !== "function") return "its headers have no get";
  for (const [name, value] of headers) {
    if (like.headers.get(name) !== value) return `its headers do not give ${JSON.stringify(name)} back`;
  }
  return null;
}

/** A base for request URLs without an origin; only the path and the query are used. */
const NO_ORIGIN = "http://contract-fixtures.invalid";

function isRequest(value: unknown): value is Request {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Request).url === "string" &&
    typeof (value as Request).clone === "function" &&
    typeof (value as Request).text === "function"
  );
}

/**
 * What shows that `request` is not a `Request` of the standard for these arguments of
 * `fetch`, or `null`. Neither the URL nor a header value is shown.
 */
function requestFault(request: Request, input: string | URL | Request, init: RequestInit | undefined): string | null {
  const like = request as Partial<Request> | null;
  if (typeof like !== "object" || like === null) return "it gives no object";
  if (typeof like.url !== "string" || typeof like.method !== "string") return "it lacks url or method";
  if (typeof like.text !== "function") return "it lacks text";
  if (typeof like.headers?.forEach !== "function") return "its headers have no forEach";
  if (!isRequest(input) && like.url !== new URL(String(input), NO_ORIGIN).href) {
    return "its url is not the one it was made with";
  }
  const method = typeof init?.method === "string" ? init.method : isRequest(input) ? input.method : "GET";
  if (like.method.toUpperCase() !== String(method).toUpperCase()) return "its method is not the one it was made with";
  return null;
}

/** The named headers, or all of them when `names` is undefined, with lower-case names. */
function pickHeaders(all: HeaderMap, names: readonly string[] | undefined): HeaderMap | undefined {
  const out = new Map<string, string | string[]>();
  if (names === undefined) {
    for (const [name, value] of Object.entries(all)) out.set(name, value);
  } else {
    for (const name of names) {
      const lower = asciiLowerCase(name);
      if (Object.hasOwn(all, lower)) out.set(lower, all[lower]!);
    }
  }
  return out.size === 0 ? undefined : (Object.fromEntries(out) as HeaderMap);
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/**
 * The request a call of `fetch` would send, in the form `verifyRequest` takes: the arguments
 * of `fetch(input, init)`, or a `Request`. Use it inside the `fetch` a test puts in the place
 * of the real one, so that the request is the one the client code really built.
 *
 * - `method` is the one of the request (`GET` when none is given), as `fetch` would send it:
 *   `fetch` writes `get` and `post` in upper case but leaves `patch` alone, and a method in
 *   lower case then fails the verify, as it would fail on most servers.
 * - `path` is the path and the query string of the URL; the origin is dropped.
 * - `headers` are the headers of the request with lower-case names, or only those named in
 *   `options.headers`. They include what `fetch` adds for the body: a string body without a
 *   `content-type` is sent as `text/plain;charset=UTF-8`, and that is what is recorded.
 * - `body` is the body parsed as JSON; there is none when the request has no body. A body
 *   that is not JSON is an error: it cannot be in a fixture.
 *
 * The headers still hold real values. List credentials under `secret` in `verifyRequest`.
 */
export async function requestFromFetch(
  input: string | URL | Request,
  init?: RequestInit,
  options: { headers?: readonly string[] } = {},
): Promise<ExchangeRequest> {
  if (typeof (globalThis as { Request?: unknown }).Request !== "function") {
    throw notStandard("requestFromFetch", "Request", "there is no global Request");
  }
  let request: Request;
  try {
    if (isRequest(input)) {
      // A copy, so that the caller's Request can still be read.
      request = init === undefined ? input.clone() : new Request(input.clone(), init);
    } else {
      request = new Request(new URL(String(input), NO_ORIGIN), init);
    }
  } catch {
    // Neither the URL nor the cause is shown: the URL may hold a credential.
    throw new ContractUsageError(
      "contract-fixtures: fetch would not send a request for these arguments " +
        "(a URL that cannot be parsed or that holds a user name, or an init that Request refuses)",
    );
  }
  const fault = requestFault(request, input, init);
  if (fault !== null) throw notStandard("requestFromFetch", "Request", fault);
  const url = new URL(request.url, NO_ORIGIN);
  const all: HeaderMap = {};
  request.headers.forEach((value, name) => {
    all[asciiLowerCase(name)] = value;
  });
  const text: unknown = await request.text();
  // A stand-in that drops the body would record a request without one.
  if (typeof text !== "string" || (typeof init?.body === "string" && text !== init.body)) {
    throw notStandard("requestFromFetch", "Request", "its text is not the body it was made with");
  }
  let body: unknown;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      // Neither the text nor the path is shown: both may hold a credential.
      throw new ContractUsageError(
        `contract-fixtures: the body of the ${request.method} request is not JSON, ` +
          "so it cannot be recorded in a fixture",
      );
    }
  }
  return withoutUndefined({
    method: request.method,
    path: url.pathname + url.search,
    headers: pickHeaders(all, options.headers),
    body: body ?? undefined,
  });
}

/** What `exchangeFromTestResponse` reads and how a test adds to it. */
export interface TestResponseOptions {
  /** Names of the request headers to record. Default: none. */
  requestHeaders?: readonly string[];
  /** Names of the response headers to record. Default: none. */
  responseHeaders?: readonly string[];
  /** Parts of the request that the response object does not hold, or that should differ. */
  request?: Partial<ExchangeRequest>;
  /** The same for the response. */
  response?: Partial<ExchangeResponse>;
}

/** A header map as test clients give it: a plain object, or something with `forEach` like `Headers`. */
function headerMap(value: unknown): HeaderMap {
  const out: HeaderMap = {};
  const add = (name: unknown, item: unknown): void => {
    if (typeof name !== "string") return;
    if (typeof item === "number") item = String(item);
    if (typeof item === "string" || (Array.isArray(item) && item.every((i) => typeof i === "string"))) {
      out[asciiLowerCase(name)] = item as string | string[];
    }
  };
  if (typeof value !== "object" || value === null) return out;
  const like = value as { forEach?: unknown; getSetCookie?: unknown };
  const prototype: unknown = Object.getPrototypeOf(value);
  const plain = prototype === Object.prototype || prototype === null;
  if (!plain && typeof like.forEach === "function") {
    (like.forEach as (callback: (item: unknown, name: unknown) => void) => void).call(value, (item, name) =>
      add(name, item),
    );
    if (typeof like.getSetCookie === "function") {
      const cookies = (like.getSetCookie as () => string[]).call(value);
      if (cookies.length > 0) add("set-cookie", cookies);
    }
    return out;
  }
  for (const [name, item] of Object.entries(value)) add(name, item);
  return out;
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function firstOf(source: unknown, keys: readonly string[]): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * The exchange behind the response object of an HTTP test client, in the form
 * `verifyResponse` takes: `contract.verifyResponse({ name, description, ...exchange })`.
 *
 * The object is read by its shape, not by its class:
 *
 * - `status` or `statusCode`: the status.
 * - `body`: the parsed body. No body when `text` is an empty string (clients of this kind
 *   give `{}` as the body of an empty response). They give `{}` for a body that is not JSON
 *   as well; when `text` shows that, this throws and asks for `response: { body }`.
 * - `headers`: the response headers, a plain object or something like `Headers`. Only the
 *   names in `responseHeaders` are recorded, because a response carries headers of the
 *   infrastructure (`date`, `connection`, `content-length`) that are not part of the
 *   agreement.
 * - `request` or `req`: the request that was sent, with `method`, `url` or `path`, and
 *   `headers` or `header`. Only the names in `requestHeaders` are recorded. Of an absolute
 *   URL, the path and the query string are kept.
 *
 * The body of the request is not looked for (test clients keep it in private fields); pass
 * it as `request: { body }`. Whatever else the object does not hold is passed the same way,
 * and what a test passes wins. Without a method, a path or a status this throws.
 *
 * The values are the real ones. List credentials under `secret` in `verifyResponse`.
 */
export function exchangeFromTestResponse(
  response: unknown,
  options: TestResponseOptions = {},
): { request: ExchangeRequest; response: ExchangeResponse } {
  // Some clients hold two request objects; each key is taken from the first that has it.
  const sources = [firstOf(response, ["request"]), firstOf(response, ["req"])];
  const sent = (keys: readonly string[]): unknown =>
    sources.map((source) => firstOf(source, keys)).find((value) => value !== undefined);
  const target = sent(["url", "path"]);
  const method = options.request?.method ?? sent(["method"]);
  const status = options.response?.status ?? firstOf(response, ["status", "statusCode"]);
  let path = options.request?.path;
  if (path === undefined && typeof target === "string") {
    try {
      const url = new URL(target, NO_ORIGIN);
      path = url.pathname + url.search;
    } catch {
      // Reported below as lacking; the value is not shown.
    }
  }
  const lacking = [
    typeof method === "string" ? "" : "request.method",
    typeof path === "string" ? "" : "request.path",
    Number.isInteger(status) ? "" : "response.status",
  ].filter((name) => name !== "");
  if (lacking.length > 0) {
    throw new ContractUsageError(
      `contract-fixtures: the response object does not show ${lacking.join(", ")}; ` +
        "pass it in the options of exchangeFromTestResponse",
    );
  }
  const text = (response as { text?: unknown } | null)?.text;
  const body = text === "" ? undefined : (response as { body?: unknown } | null)?.body;
  if (
    !Object.hasOwn(options.response ?? {}, "body") &&
    typeof text === "string" &&
    text !== "" &&
    isEmptyObject(body) &&
    !isEmptyObject(parsed(text))
  ) {
    // Clients of this kind give `{}` for a body they did not parse (HTML, plain text, CSV).
    throw new ContractUsageError(
      "contract-fixtures: the response object has a text that is not JSON, and an empty object as its body. " +
        "Pass `response: { body: null }` to record no body, or `response: { body: <the text> }` to record the text",
    );
  }
  return {
    request: withoutUndefined({
      method: method as string,
      path: path as string,
      headers: pickHeaders(headerMap(sent(["headers", "header"])), options.requestHeaders ?? []),
      ...withoutUndefined(options.request ?? {}),
    }),
    response: withoutUndefined({
      status: status as number,
      headers: pickHeaders(headerMap(firstOf(response, ["headers"])), options.responseHeaders ?? []),
      body: body ?? undefined,
      ...withoutUndefined(options.response ?? {}),
    }),
  };
}
