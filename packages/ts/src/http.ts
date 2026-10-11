/**
 * Glue between fixtures and the two places tests usually meet HTTP: the standard `fetch`
 * (`Request`, `Response`, `Headers`) on the consumer side, and the response object of an HTTP
 * test client on the provider side. Nothing here depends on a library; the test client is
 * read by the shape of its objects.
 */
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
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  // Bytes, not a string: a string would make the Response invent `content-type: text/plain`.
  const bytes = hasBody ? new TextEncoder().encode(JSON.stringify(body)) : null;
  return new Response(bytes, { status, headers });
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
 * - `method` is the one of the request (`GET` when none is given).
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
  let request: Request;
  if (isRequest(input)) {
    // A copy, so that the caller's Request can still be read.
    request = init === undefined ? input.clone() : new Request(input.clone(), init);
  } else {
    request = new Request(new URL(String(input), NO_ORIGIN), init);
  }
  const url = new URL(request.url, NO_ORIGIN);
  const all: HeaderMap = {};
  request.headers.forEach((value, name) => {
    all[asciiLowerCase(name)] = value;
  });
  const text = await request.text();
  let body: unknown;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      // The text is not shown: it may hold a credential.
      throw new ContractUsageError(
        `contract-fixtures: the body of the request ${request.method} ${url.pathname} is not JSON, ` +
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
 *   give `{}` as the body of an empty response).
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
  const sent = firstOf(response, ["request", "req"]);
  const target = options.request?.path ?? firstOf(sent, ["url", "path"]);
  const method = options.request?.method ?? firstOf(sent, ["method"]);
  const status = options.response?.status ?? firstOf(response, ["status", "statusCode"]);
  const lacking = [
    typeof method === "string" ? "" : "request.method",
    typeof target === "string" ? "" : "request.path",
    typeof status === "number" ? "" : "response.status",
  ].filter((name) => name !== "");
  if (lacking.length > 0) {
    throw new ContractUsageError(
      `contract-fixtures: the response object does not show ${lacking.join(", ")}; ` +
        "pass it in the options of exchangeFromTestResponse",
    );
  }
  const url = new URL(target as string, NO_ORIGIN);
  const empty = typeof response === "object" && response !== null && (response as { text?: unknown }).text === "";
  const body = empty ? undefined : (response as { body?: unknown }).body;
  return {
    request: withoutUndefined({
      method: method as string,
      path: options.request?.path ?? url.pathname + url.search,
      headers: pickHeaders(headerMap(firstOf(sent, ["headers", "header"])), options.requestHeaders ?? []),
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
