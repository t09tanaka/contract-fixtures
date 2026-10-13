import type { VolatileEntry } from "./volatile.js";

/** The format version this package reads and writes. */
export const FORMAT_VERSION = 1;

/** Which side of the API a test (or a check) acts for. */
export type Side = "provider" | "consumer";

/** The three directories of a contracts directory. */
export type Kind = "provider" | "consumer" | "tables";

export const SIDES: readonly Side[] = ["provider", "consumer"];
export const KINDS: readonly Kind[] = ["provider", "consumer", "tables"];

export interface ExchangeRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** Starts with `/`; includes the query string, if any. */
  path: string;
  /**
   * Header names are lower-cased before comparing and writing. A value is a string, or a
   * non-empty array of strings for a header that is sent more than once.
   */
  headers?: Record<string, string | string[]>;
  /** Any JSON value. `null` and `undefined` both mean "no body". */
  body?: unknown;
}

export interface ExchangeResponse {
  status: number;
  /** As in a request: lower-cased names; a string, or an array for a repeated header. */
  headers?: Record<string, string | string[]>;
  /** The parsed body. `null` and `undefined` both mean "no body". */
  body?: unknown;
}

/** A request and the provider's real response to it (`provider/<name>.json`). */
export interface ProviderFixture {
  format: typeof FORMAT_VERSION;
  name: string;
  description: string;
  request: ExchangeRequest;
  response: ExchangeResponse;
  volatile?: VolatileEntry[];
  /** Path -> placeholder: what is stored in place of the real value at that path. */
  secret?: Record<string, string>;
}

/** A request the consumer really builds (`consumer/<name>.json`). */
export interface ConsumerFixture {
  format: typeof FORMAT_VERSION;
  name: string;
  description: string;
  request: ExchangeRequest;
  volatile?: VolatileEntry[];
  /** Path -> placeholder: what is stored in place of the real value at that path. */
  secret?: Record<string, string>;
}

/** Rows of input and expected output for a shared calculation (`tables/<name>.json`). */
export interface TableFixture<Row = Record<string, unknown>> {
  format: typeof FORMAT_VERSION;
  name: string;
  description: string;
  rows: Row[];
}

/**
 * An entry of `volatile` as a test passes it: what a fixture holds, or `{ path }` alone, which
 * means the same as the path as a string and is written as that.
 */
export type ObservedVolatileEntry = VolatileEntry | { path: string };

/**
 * A value of `secret` as a test passes it: the placeholder, or the placeholder with
 * `optional: true` for a path that need not be there (a header that only some requests of a
 * shared helper carry). Where the path matches nothing, such an entry is left out; a fixture
 * always holds path and placeholder.
 */
export type ObservedSecret = string | { placeholder: string; optional?: boolean };

/** What only the verifying test says, in the form a test passes it. */
interface ObservedMarks {
  volatile?: ObservedVolatileEntry[];
  secret?: Record<string, ObservedSecret>;
}

/** What a provider test observed, to be verified against `provider/<name>.json`. */
export type ObservedResponse = Omit<ProviderFixture, "format" | "volatile" | "secret"> & ObservedMarks;

/** What a consumer test built, to be verified against `consumer/<name>.json`. */
export type ObservedRequest = Omit<ConsumerFixture, "format" | "volatile" | "secret"> & ObservedMarks;

/** What a verify did, for a test that wants to assert on it. A verify that fails throws. */
export interface Verified {
  /** The fixture, as `check` names it: `provider/order.created.json`. */
  file: string;
  /** Whether update mode wrote the file in this call. */
  written: boolean;
}
