import fs from "node:fs";
import path from "node:path";

import { listFixtureNames } from "./check.js";
import { differences, formatDifferences } from "./differences.js";
import {
  ContractCoverageError,
  ContractFixtureError,
  ContractMismatchError,
  ContractUsageError,
} from "./errors.js";
import {
  asciiLowerCase,
  canonicalJson,
  isObject,
  jsonRoundTrip,
  NotJsonError,
  sortedKeys,
} from "./json.js";
import { appendLedger } from "./ledger.js";
import { replaceSecrets } from "./secrets.js";
import type { VolatileEntry } from "./volatile.js";
import {
  FORMAT_VERSION,
  type ConsumerFixture,
  type Kind,
  type ObservedRequest,
  type ObservedResponse,
  type ProviderFixture,
  type Side,
  type TableFixture,
} from "./types.js";
import {
  formatIssues,
  type FormatIssue,
  NAME_PATTERN,
  validateFixtureFile,
  validateFixtureValue,
} from "./validate.js";

/** Environment variable that names the contracts directory when no `dir` option is given. */
export const DIR_ENV = "CONTRACT_FIXTURES_DIR";
/** Environment variable that turns update mode on when it is `1`. */
export const UPDATE_ENV = "CONTRACT_FIXTURES_UPDATE";

export interface ContractFixturesOptions {
  /** The side whose tests are running. */
  side: Side;
  /** The contracts directory. Defaults to the environment variable `CONTRACT_FIXTURES_DIR`. */
  dir?: string;
  /** Write fixtures instead of failing. Defaults to `CONTRACT_FIXTURES_UPDATE=1`. */
  update?: boolean;
}

export interface ContractFixtures {
  readonly side: Side;
  /** Absolute path of the contracts directory. */
  readonly dir: string;
  readonly update: boolean;

  /** Names of the fixtures of one kind, sorted; optionally only those that start with `prefix`. */
  list(kind: Kind, options?: { prefix?: string }): string[];

  /**
   * Fails unless `expected` names exactly the fixtures of `kind` (that start with `prefix`).
   * Give it the keys of the table of expectations a reading test iterates over: a new fixture
   * then fails this test until somebody writes down what should happen for it.
   */
  assertCovers(kind: Kind, expected: Iterable<string>, options?: { prefix?: string }): void;

  /**
   * Fails unless every fixture of `kind` starts with one of `prefixes`, and every prefix has
   * a fixture. Tests that call `assertCovers` with a prefix each cover a part of the
   * fixtures; this is the one test that shows the parts leave nothing out.
   */
  assertPrefixesCover(kind: Kind, prefixes: Iterable<string>): void;

  /**
   * Provider side: compares a real response with `provider/<name>.json`.
   * Throws `ContractMismatchError` on a difference; writes the fixture in update mode.
   */
  verifyResponse(observed: ObservedResponse): void;

  /**
   * Consumer side: compares a request this side really built with `consumer/<name>.json`.
   * Throws `ContractMismatchError` on a difference; writes the fixture in update mode.
   */
  verifyRequest(observed: ObservedRequest): void;

  /** Consumer side: reads `provider/<name>.json` to feed the response to the real client code. */
  readResponse(name: string): ProviderFixture;

  /** Provider side: reads `consumer/<name>.json` to send the request to the real API. */
  readRequest(name: string): ConsumerFixture;

  /** Either side: reads `tables/<name>.json`. */
  readTable<Row = Record<string, unknown>>(name: string): TableFixture<Row>;
}

function lowerCaseHeaders(file: string, headers: unknown): unknown {
  if (!isObject(headers)) return headers;
  // A Map, because assigning the key "__proto__" to a plain object would not create a key.
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(headers)) {
    const lower = asciiLowerCase(key);
    if (out.has(lower)) {
      throw new ContractUsageError(
        `contract fixture ${file}: the header ${lower} is given more than once (names differ only in case)`,
      );
    }
    out.set(lower, value);
  }
  return Object.fromEntries(out);
}

/** `value` with the known keys first, in the order the format writes them. */
function ordered(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) out[key] = value[key];
  }
  // Unknown keys are kept so that validation reports them instead of dropping them silently.
  return { ...out, ...value };
}

function exchangePart(file: string, value: unknown, keys: readonly string[]): unknown {
  if (!isObject(value)) return value;
  const out = ordered(value, keys);
  if (out.body === null) delete out.body;
  if (Object.hasOwn(out, "headers")) out.headers = lowerCaseHeaders(file, out.headers);
  return out;
}

/** The fixture a side produced, as it would be written: placeholders in place of secrets. */
function candidate(file: string, observed: object): Record<string, unknown> {
  let wire: Record<string, unknown>;
  try {
    wire = jsonRoundTrip({ ...observed, format: FORMAT_VERSION }) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof NotJsonError)) throw error;
    throw new ContractFixtureError(
      `contract fixture ${file}: what this side produced is not a valid fixture:\n` +
        "  (root): cannot be encoded as JSON (a number that is NaN or infinite)",
      file,
    );
  }
  const out = ordered(wire, ["format", "name", "description", "request", "response", "volatile", "secret"]);
  if (Object.hasOwn(out, "request")) {
    out.request = exchangePart(file, out.request, ["method", "path", "headers", "body"]);
  }
  if (Object.hasOwn(out, "response")) {
    out.response = exchangePart(file, out.response, ["status", "headers", "body"]);
  }
  if (Array.isArray(out.volatile)) {
    if (out.volatile.length === 0) delete out.volatile;
    else out.volatile = out.volatile.map((e: unknown) => (isObject(e) ? ordered(e, ["path", "pattern"]) : e));
  }
  if (isObject(out.secret) && Object.keys(out.secret).length === 0) delete out.secret;
  // From here on the real values are gone: nothing below can print or write them.
  replaceSecrets(out, out.secret, "strings");
  return out;
}

/**
 * `produced` as it is compared with the stored fixture. Paths that only the stored fixture
 * lists as secret are covered as well, so that the difference names the path (and the change
 * of `secret`) without printing a value that used to be kept out of the file.
 */
function comparable(produced: Record<string, unknown>, stored: unknown): unknown {
  const removed = removedSecretPaths(produced, stored);
  if (removed.length === 0) return produced;
  const copy = jsonRoundTrip(produced);
  replaceSecrets(copy, (stored as { secret: unknown }).secret, "everything", (p) => !removed.includes(p));
  return copy;
}

/** The secret paths of the stored fixture that what this side produced does not list. */
function removedSecretPaths(produced: Record<string, unknown>, stored: unknown): string[] {
  const storedSecret = isObject(stored) ? stored.secret : undefined;
  if (!isObject(storedSecret)) return [];
  const own = isObject(produced.secret) ? produced.secret : {};
  return sortedKeys(storedSecret).filter((p) => !Object.hasOwn(own, p));
}

/**
 * Update mode never drops a secret path: the value behind it would be written as it really
 * is. Whoever wants the path gone removes it from the stored file by hand.
 */
function refuseToRemoveSecrets(file: string, produced: Record<string, unknown>, stored: unknown): void {
  const issues: FormatIssue[] = removedSecretPaths(produced, stored).map((p) => ({
    code: "secret-removed",
    path: `secret.${p}`,
    message: "is a secret path of the stored fixture, but this test does not pass it",
  }));
  if (issues.length === 0) return;
  throw new ContractFixtureError(
    `contract fixture ${file} is not updated, because that would drop a secret path:\n` +
      `${formatIssues(issues)}\n` +
      "Pass the path as `secret` in this test, or remove it from the stored file by hand.",
    file,
    issues,
  );
}

/** Update mode as the environment asks for it. Refused in CI, where it would hide every change. */
function updateFromEnvironment(env: Record<string, string | undefined>): boolean {
  if (env[UPDATE_ENV] !== "1") return false;
  if (env.CI === "true" || env.CI === "1") {
    throw new ContractUsageError(
      `contract-fixtures: ${UPDATE_ENV}=1 is set in CI. Update fixtures on a developer's machine and commit them.`,
    );
  }
  return true;
}

/**
 * Opens a contracts directory on behalf of one side. The returned helpers do not depend on a
 * test framework: they throw ordinary errors, which every framework reports as a failure.
 */
export function contractFixtures(options: ContractFixturesOptions): ContractFixtures {
  const { side } = options;
  if (side !== "provider" && side !== "consumer") {
    throw new ContractUsageError(`contract-fixtures: side must be "provider" or "consumer"`);
  }
  const given = options.dir ?? process.env[DIR_ENV];
  if (given === undefined || given === "") {
    throw new ContractUsageError(
      `contract-fixtures: pass the contracts directory as \`dir\` or set ${DIR_ENV}`,
    );
  }
  const dir = path.resolve(given);
  const update = options.update ?? updateFromEnvironment(process.env);

  const requireSide = (wanted: Side, method: string): void => {
    if (side !== wanted) {
      throw new ContractUsageError(
        `contract-fixtures: ${method} is for the ${wanted} side, but this is the ${side} side`,
      );
    }
  };
  const requireName = (name: unknown): string => {
    if (typeof name !== "string" || name === "") {
      throw new ContractUsageError("contract-fixtures: a fixture needs a name");
    }
    return name;
  };

  /** A string is an iterable of its characters, which is never what a test means. */
  const requireNames = (names: unknown, method: string): void => {
    if (typeof names === "string") {
      throw new ContractUsageError(`contract-fixtures: ${method} takes a list of names, not one string`);
    }
  };

  const verify = (kind: "provider" | "consumer", observed: { name: string }): void => {
    const name = requireName(observed?.name);
    const file = `${kind}/${name}.json`;
    const filePath = path.join(dir, kind, `${name}.json`);
    const produced = candidate(file, observed);
    const refuse = (issues: FormatIssue[]): void => {
      if (issues.length === 0) return;
      throw new ContractFixtureError(
        `contract fixture ${file}: what this side produced is not a valid fixture:\n` +
          formatIssues(issues),
        file,
        issues,
      );
    };
    // A value that does not match the pattern of its own volatile entry is a difference from
    // the stored fixture, if there is one to compare with. It is never written.
    const producedIssues = validateFixtureValue(kind, name, produced);
    const unmatchedPatterns = producedIssues.filter((issue) => issue.code === "volatile-pattern");
    refuse(producedIssues.filter((issue) => issue.code !== "volatile-pattern"));
    const write = (): void => {
      refuse(unmatchedPatterns);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, canonicalJson(produced));
    };

    if (!fs.existsSync(filePath)) {
      if (!update) {
        throw new ContractFixtureError(
          `contract fixture ${file} does not exist. ` +
            `Run this test once with ${UPDATE_ENV}=1 to record it.`,
          file,
        );
      }
      write();
    } else {
      const stored = validateFixtureFile(kind, name, filePath);
      if (update) refuseToRemoveSecrets(file, produced, stored.value);
      if (stored.issues.length > 0) {
        if (!update) {
          throw new ContractFixtureError(
            `contract fixture ${file} does not follow the format:\n` + formatIssues(stored.issues),
            file,
            stored.issues,
          );
        }
        write();
      } else {
        const volatile = (stored.value as { volatile?: VolatileEntry[] }).volatile ?? [];
        const diffs = differences(stored.value, comparable(produced, stored.value), volatile);
        if (diffs.length > 0) {
          if (!update) {
            throw new ContractMismatchError(
              `contract fixture ${file} no longer matches what the ${side} side produces ` +
                `(stored -> observed):\n${formatDifferences(diffs)}\n` +
                `If the change is intended, rerun with ${UPDATE_ENV}=1, ` +
                "then fix the other side's tests in the same change.",
              file,
              diffs,
            );
          }
          write();
        }
        refuse(unmatchedPatterns);
      }
    }
    appendLedger(dir, side, "verified", kind, name);
  };

  const read = (kind: Kind, rawName: string): unknown => {
    const name = requireName(rawName);
    if (!NAME_PATTERN.test(name)) {
      throw new ContractUsageError(`contract-fixtures: ${JSON.stringify(name)} is not a fixture name`);
    }
    const file = `${kind}/${name}.json`;
    const filePath = path.join(dir, kind, `${name}.json`);
    if (!fs.existsSync(filePath)) {
      throw new ContractFixtureError(`contract fixture ${file} does not exist.`, file);
    }
    const { value, issues } = validateFixtureFile(kind, name, filePath);
    if (issues.length > 0) {
      throw new ContractFixtureError(
        `contract fixture ${file} does not follow the format:\n` + formatIssues(issues),
        file,
        issues,
      );
    }
    appendLedger(dir, side, "read", kind, name);
    return value;
  };

  const list = (kind: Kind, listOptions: { prefix?: string } = {}): string[] => {
    const prefix = listOptions.prefix ?? "";
    return listFixtureNames(dir, kind).filter((name) => name.startsWith(prefix));
  };

  return {
    side,
    dir,
    update,
    list,
    assertCovers(kind, expected, coverOptions = {}) {
      requireNames(expected, "assertCovers");
      const onDisk = list(kind, coverOptions);
      const wanted = [...new Set(expected)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const withoutExpectation = onDisk.filter((name) => !wanted.includes(name));
      const withoutFixture = wanted.filter((name) => !onDisk.includes(name));
      if (withoutExpectation.length === 0 && withoutFixture.length === 0) return;
      const scope = coverOptions.prefix ? `${kind}/${coverOptions.prefix}*` : `${kind}/`;
      const lines = [
        `the expectations of this test do not cover the fixtures in ${scope}:`,
        ...withoutExpectation.map((name) => `  ${kind}/${name}.json: no expectation in this test`),
        ...withoutFixture.map((name) =>
          name.startsWith(coverOptions.prefix ?? "")
            ? `  ${name}: expected here, but ${kind}/${name}.json does not exist`
            : `  ${name}: expected here, but it does not start with ${coverOptions.prefix}`,
        ),
      ];
      throw new ContractCoverageError(lines.join("\n"), withoutExpectation, withoutFixture);
    },
    assertPrefixesCover(kind, prefixes) {
      requireNames(prefixes, "assertPrefixesCover");
      const onDisk = list(kind);
      const wanted = [...new Set(prefixes)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const outside = onDisk.filter((name) => !wanted.some((prefix) => name.startsWith(prefix)));
      const unused = wanted.filter((prefix) => !onDisk.some((name) => name.startsWith(prefix)));
      if (outside.length === 0 && unused.length === 0) return;
      const lines = [
        `the prefixes of this test do not cover the fixtures in ${kind}/:`,
        ...outside.map((name) => `  ${kind}/${name}.json: starts with none of the prefixes`),
        ...unused.map((prefix) => `  ${prefix}*: listed here, but no fixture in ${kind}/ starts with it`),
      ];
      throw new ContractCoverageError(lines.join("\n"), outside, unused);
    },
    verifyResponse(observed) {
      requireSide("provider", "verifyResponse");
      verify("provider", observed);
    },
    verifyRequest(observed) {
      requireSide("consumer", "verifyRequest");
      verify("consumer", observed);
    },
    readResponse(name) {
      requireSide("consumer", "readResponse");
      return read("provider", name) as ProviderFixture;
    },
    readRequest(name) {
      requireSide("provider", "readRequest");
      return read("consumer", name) as ConsumerFixture;
    },
    readTable<Row = Record<string, unknown>>(name: string) {
      return read("tables", name) as TableFixture<Row>;
    },
  };
}
