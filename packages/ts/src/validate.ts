import { volatileMode } from "./differences.js";
import { isObject, isUnsafeInteger, jsonType, sortedKeys } from "./json.js";
import { FORMAT_VERSION, type Kind } from "./types.js";

/** One way in which a file does not follow the fixture format. */
export interface FormatIssue {
  /** A stable identifier, the same in every implementation. */
  code:
    | "json"
    | "root"
    | "format"
    | "name"
    | "description"
    | "unknown-key"
    | "request"
    | "method"
    | "path"
    | "headers"
    | "body"
    | "response"
    | "status"
    | "volatile"
    | "volatile-unmatched"
    | "rows"
    | "number";
  /** Where in the file, as a dot separated path (`(root)` for the file itself). */
  path: string;
  message: string;
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const TOP_LEVEL: Record<Kind, readonly string[]> = {
  provider: ["format", "name", "description", "request", "response", "volatile"],
  consumer: ["format", "name", "description", "request", "volatile"],
  tables: ["format", "name", "description", "rows"],
};

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function unknownKeys(
  issues: FormatIssue[],
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): void {
  for (const key of sortedKeys(value)) {
    if (!allowed.includes(key)) {
      issues.push({
        code: "unknown-key",
        path: prefix === "" ? key : `${prefix}.${key}`,
        message: `unknown key (allowed: ${allowed.join(", ")})`,
      });
    }
  }
}

function validateRequest(issues: FormatIssue[], request: unknown): void {
  if (!isObject(request)) {
    issues.push({ code: "request", path: "request", message: "must be an object" });
    return;
  }
  unknownKeys(issues, request, ["method", "path", "headers", "body"], "request");
  if (typeof request.method !== "string" || !/^[A-Z]+$/.test(request.method)) {
    issues.push({
      code: "method",
      path: "request.method",
      message: "must be an upper-case HTTP method",
    });
  }
  if (typeof request.path !== "string" || !request.path.startsWith("/")) {
    issues.push({
      code: "path",
      path: "request.path",
      message: "must be a string that starts with /",
    });
  }
  if (Object.hasOwn(request, "headers")) {
    const headers = request.headers;
    if (!isObject(headers)) {
      issues.push({ code: "headers", path: "request.headers", message: "must be an object" });
    } else {
      for (const key of sortedKeys(headers)) {
        if (key !== key.toLowerCase()) {
          issues.push({
            code: "headers",
            path: `request.headers.${key}`,
            message: "header names must be lower case",
          });
        } else if (typeof headers[key] !== "string") {
          issues.push({
            code: "headers",
            path: `request.headers.${key}`,
            message: "header values must be strings",
          });
        }
      }
    }
  }
  if (Object.hasOwn(request, "body") && request.body === null) {
    issues.push({
      code: "body",
      path: "request.body",
      message: "must not be null (omit the key when there is no body)",
    });
  }
}

function validateResponse(issues: FormatIssue[], response: unknown): void {
  if (!isObject(response)) {
    issues.push({ code: "response", path: "response", message: "must be an object" });
    return;
  }
  unknownKeys(issues, response, ["status", "body"], "response");
  const status = response.status;
  if (!isInteger(status) || status < 100 || status > 599) {
    issues.push({
      code: "status",
      path: "response.status",
      message: "must be an integer from 100 to 599",
    });
  }
  if (Object.hasOwn(response, "body") && response.body === null) {
    issues.push({
      code: "body",
      path: "response.body",
      message: "must not be null (omit the key when there is no body)",
    });
  }
}

/** Whether a volatile path matches at least one node of the fixture. */
function matchesSomething(root: unknown, pattern: string[]): boolean {
  const walk = (node: unknown, segments: string[]): boolean => {
    if (volatileMode([pattern], segments) !== null) return true;
    if (Array.isArray(node)) {
      return node.some((item, i) => walk(item, [...segments, String(i)]));
    }
    if (isObject(node)) {
      return sortedKeys(node).some((key) => walk(node[key], [...segments, key]));
    }
    return false;
  };
  return walk(root, []);
}

function validateVolatile(
  issues: FormatIssue[],
  fixture: Record<string, unknown>,
  roots: readonly string[],
): void {
  const volatile = fixture.volatile;
  if (!Array.isArray(volatile)) {
    issues.push({ code: "volatile", path: "volatile", message: "must be an array of strings" });
    return;
  }
  volatile.forEach((entry: unknown, i: number) => {
    const path = `volatile.${i}`;
    if (typeof entry !== "string") {
      issues.push({ code: "volatile", path, message: "must be a string" });
      return;
    }
    const segments = entry.split(".");
    if (segments.some((s) => s === "")) {
      issues.push({ code: "volatile", path, message: "must not contain empty segments" });
      return;
    }
    if (segments.slice(0, -1).includes("**")) {
      issues.push({ code: "volatile", path, message: "** is allowed only as the last segment" });
      return;
    }
    if (!roots.includes(segments[0]!)) {
      issues.push({
        code: "volatile",
        path,
        message: `must start with ${roots.join(" or ")}`,
      });
      return;
    }
    if (!matchesSomething(fixture, segments)) {
      issues.push({
        code: "volatile-unmatched",
        path,
        message: `${entry} matches nothing in this fixture`,
      });
    }
  });
}

/** Integers beyond 2^53 - 1 do not survive every JSON parser, so they are not allowed. */
function validateNumbers(issues: FormatIssue[], root: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (isUnsafeInteger(node)) {
      issues.push({
        code: "number",
        path,
        message: "is an integer beyond 2^53 - 1, which not every JSON parser keeps exact (use a string)",
      });
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}.${i}`));
    } else if (isObject(node)) {
      for (const key of sortedKeys(node)) walk(node[key], path === "" ? key : `${path}.${key}`);
    }
  };
  walk(root, "");
}

/**
 * Checks a parsed fixture against format 1. `name` is the file name without `.json`.
 * Returns an empty array when the fixture is valid.
 */
export function validateFixtureValue(kind: Kind, name: string, value: unknown): FormatIssue[] {
  const issues: FormatIssue[] = [];
  if (!isObject(value)) {
    return [{ code: "root", path: "(root)", message: "must be a JSON object" }];
  }
  unknownKeys(issues, value, TOP_LEVEL[kind], "");
  if (value.format !== FORMAT_VERSION) {
    issues.push({
      code: "format",
      path: "format",
      message: `must be ${FORMAT_VERSION} (this is the only format this version reads)`,
    });
  }
  if (typeof value.name !== "string" || !NAME_PATTERN.test(value.name)) {
    issues.push({
      code: "name",
      path: "name",
      message: "must be a string of letters, digits, '.', '_' and '-'",
    });
  } else if (value.name !== name) {
    issues.push({
      code: "name",
      path: "name",
      message: `must equal the file name without .json (${name})`,
    });
  }
  if (typeof value.description !== "string" || value.description === "") {
    issues.push({
      code: "description",
      path: "description",
      message: "must be a non-empty string",
    });
  }
  if (kind === "tables") {
    const rows = value.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      issues.push({ code: "rows", path: "rows", message: "must be a non-empty array" });
    } else {
      rows.forEach((row: unknown, i: number) => {
        if (!isObject(row)) {
          issues.push({
            code: "rows",
            path: `rows.${i}`,
            message: `must be an object, not ${jsonType(row)}`,
          });
        }
      });
    }
    validateNumbers(issues, value);
    return issues;
  }
  validateRequest(issues, value.request);
  if (kind === "provider") validateResponse(issues, value.response);
  if (Object.hasOwn(value, "volatile")) {
    validateVolatile(issues, value, kind === "provider" ? ["request", "response"] : ["request"]);
  }
  validateNumbers(issues, value);
  return issues;
}

/** Parses the text of a fixture file and checks it against format 1. */
export function validateFixture(
  kind: Kind,
  name: string,
  text: string,
): { value: unknown; issues: FormatIssue[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      value: undefined,
      issues: [{ code: "json", path: "(root)", message: "is not valid JSON" }],
    };
  }
  return { value, issues: validateFixtureValue(kind, name, value) };
}

export function formatIssues(issues: readonly FormatIssue[]): string {
  return issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
}
