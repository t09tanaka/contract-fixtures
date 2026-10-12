import fs from "node:fs";

import type { ContractsConfig } from "./configuration.js";
import { compilePattern, PatternError, type CompiledPattern } from "./pattern.js";
import {
  entryParts,
  lenientRules,
  ruleMatch,
  satisfies,
  volatileMode,
  volatileRule,
  type VolatileRule,
} from "./volatile.js";
import { isObject, isUnsafeNumber, jsonType, shownJson, sortedKeys } from "./json.js";
import { parsePlaceholder } from "./placeholders.js";
import { JWT_PATTERN, secretNodes, secretPathProblem } from "./secrets.js";
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
    | "volatile-pattern"
    | "pattern"
    | "secret"
    | "secret-unmatched"
    | "secret-value"
    | "secret-volatile"
    /** Not a fault of a file: update mode was asked to drop a secret path (see contract.ts). */
    | "secret-removed"
    | "jwt"
    | "forbidden"
    | "rows"
    | "number";
  /** Where in the file, as a dot separated path (`(root)` for the file itself). */
  path: string;
  message: string;
}

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const TOP_LEVEL: Record<Kind, readonly string[]> = {
  provider: ["format", "name", "description", "request", "response", "volatile", "secret"],
  consumer: ["format", "name", "description", "request", "volatile", "secret"],
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

/** A header value: a string, or a non-empty array of strings (a header sent more than once). */
function isHeaderValue(value: unknown): boolean {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

function validateHeaders(issues: FormatIssue[], part: Record<string, unknown>, prefix: string): void {
  if (!Object.hasOwn(part, "headers")) return;
  const headers = part.headers;
  if (!isObject(headers)) {
    issues.push({ code: "headers", path: `${prefix}.headers`, message: "must be an object" });
    return;
  }
  for (const key of sortedKeys(headers)) {
    if (key === "" || /[A-Z]/.test(key)) {
      issues.push({
        code: "headers",
        path: `${prefix}.headers.${key}`,
        message: "header names must be non-empty and lower case",
      });
    } else if (!isHeaderValue(headers[key])) {
      issues.push({
        code: "headers",
        path: `${prefix}.headers.${key}`,
        message: "header values must be strings or non-empty arrays of strings",
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
  validateHeaders(issues, request, "request");
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
  unknownKeys(issues, response, ["status", "headers", "body"], "response");
  const status = response.status;
  if (!isInteger(status) || status < 100 || status > 599) {
    issues.push({
      code: "status",
      path: "response.status",
      message: "must be an integer from 100 to 599",
    });
  }
  validateHeaders(issues, response, "response");
  if (Object.hasOwn(response, "body") && response.body === null) {
    issues.push({
      code: "body",
      path: "response.body",
      message: "must not be null (omit the key when there is no body)",
    });
  }
}

/** The nodes of the fixture that a rule names (not those below a path that ends in `**`). */
function matchedNodes(root: unknown, rule: VolatileRule): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  const walk = (node: unknown, segments: string[]): void => {
    if (ruleMatch(rule, segments) !== null) out.push({ path: segments.join("."), value: node });
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, [...segments, String(i)]));
    else if (isObject(node)) for (const key of sortedKeys(node)) walk(node[key], [...segments, key]);
  };
  walk(root, []);
  return out;
}

/** Why `path` cannot be a volatile path, or `null` when it can. */
function volatilePathProblem(path: string, roots: readonly string[]): string | null {
  const segments = path.split(".");
  if (segments.some((s) => s === "")) return "must not contain empty segments";
  if (segments.some((s) => s.includes("*") && s !== "*" && s !== "**")) {
    return "* is allowed only as a whole segment (* or **)";
  }
  if (segments.filter((s) => s === "**").length > 1) return "** is allowed only once in a path";
  if (!roots.includes(segments[0]!)) return `must start with ${roots.join(" or ")}`;
  if (segments.length < 2 || segments[1] === "*" || segments[1] === "**") {
    return `must name a key of ${segments[0]} (a path that covers the whole ${segments[0]} would switch the comparison off)`;
  }
  return null;
}

function validateVolatile(
  issues: FormatIssue[],
  fixture: Record<string, unknown>,
  roots: readonly string[],
  forbidden: readonly CompiledPattern[],
): void {
  const volatile = fixture.volatile;
  if (!Array.isArray(volatile)) {
    issues.push({ code: "volatile", path: "volatile", message: "must be an array" });
    return;
  }
  // A value is shown, so that a pattern that misses can be corrected, unless it may be a
  // secret: a node that a secret path names, a string of the shape of a token, or one that
  // the configuration of the directory forbids.
  const hidden = new Set<string>();
  if (isObject(fixture.secret)) {
    for (const key of sortedKeys(fixture.secret)) {
      if (secretPathProblem(key, roots) !== null) continue;
      for (const node of secretNodes(fixture, key.split("."))) hidden.add(node.segments.join("."));
    }
  }
  const shown = (nodePath: string, value: string): string =>
    hidden.has(nodePath) || JWT_PATTERN.test(value) || forbidden.some((pattern) => pattern.search(value))
      ? ""
      : `${shownJson(value)} `;
  volatile.forEach((entry: unknown, i: number) => {
    const path = `volatile.${i}`;
    const parts = entryParts(entry);
    if (parts === null) {
      issues.push({
        code: "volatile",
        path,
        message:
          "must be a path, or an object with the keys path and pattern (both strings) and, optionally, nullable (true)",
      });
      return;
    }
    const problem = volatilePathProblem(parts.path, roots);
    if (problem !== null) {
      issues.push({ code: "volatile", path, message: problem });
      return;
    }
    if (parts.pattern !== null && parts.path.endsWith(".**")) {
      issues.push({
        code: "volatile",
        path,
        message: "a path that ends in ** cannot have a pattern (a pattern is for one string)",
      });
      return;
    }
    let rule: VolatileRule;
    try {
      rule = volatileRule(parts);
    } catch (error) {
      if (!(error instanceof PatternError)) throw error;
      issues.push({
        code: "pattern",
        path: `${path}.pattern`,
        message: `is not a pattern this format supports: ${error.message}`,
      });
      return;
    }
    const nodes = matchedNodes(fixture, rule);
    if (nodes.length === 0) {
      issues.push({
        code: "volatile-unmatched",
        path,
        message: `${parts.path} matches nothing in this fixture`,
      });
      return;
    }
    if (rule.matcher === null) return;
    for (const node of nodes) {
      if (ruleMatch(rule, node.path.split(".")) !== "exact") continue;
      if (satisfies(rule, node.value)) continue;
      issues.push({
        code: "volatile-pattern",
        path: node.path,
        message:
          typeof node.value === "string"
            ? `${shown(node.path, node.value)}does not match the pattern ${rule.source} of ${path}`
            : `must be a string that matches the pattern ${rule.source} of ${path}${rule.nullable ? ", or null" : ""} (found ${jsonType(node.value)})`,
      });
    }
  });
}

/** Whole numbers beyond 2^53 - 1 do not survive every JSON parser, so they are not allowed. */
function validateNumbers(issues: FormatIssue[], root: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (isUnsafeNumber(node)) {
      issues.push({
        code: "number",
        path,
        message:
          "is a whole number beyond 2^53 - 1 or not finite, which not every JSON parser keeps exact (use a string)",
      });
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}.${i}`));
    } else if (isObject(node)) {
      for (const key of sortedKeys(node)) walk(node[key], path === "" ? key : `${path}.${key}`);
    }
  };
  walk(root, "");
}

function validateSecret(
  issues: FormatIssue[],
  fixture: Record<string, unknown>,
  roots: readonly string[],
): void {
  const secret = fixture.secret;
  if (!isObject(secret)) {
    issues.push({
      code: "secret",
      path: "secret",
      message: "must be an object of paths and placeholders",
    });
    return;
  }
  const volatile = lenientRules(fixture.volatile);
  for (const key of sortedKeys(secret)) {
    const path = `secret.${key}`;
    const problem = secretPathProblem(key, roots);
    if (problem !== null) {
      issues.push({ code: "secret", path, message: problem });
      continue;
    }
    const placeholder = secret[key];
    if (typeof placeholder !== "string" || parsePlaceholder(placeholder) === null) {
      issues.push({
        code: "secret",
        path,
        message: "must be a placeholder such as <token:customer-1>",
      });
      continue;
    }
    const nodes = secretNodes(fixture, key.split("."));
    if (nodes.length === 0) {
      issues.push({
        code: "secret-unmatched",
        path,
        message: `${key} matches nothing in this fixture`,
      });
      continue;
    }
    for (const node of nodes) {
      if (node.value === placeholder) continue;
      // The value itself is never printed: it may be the secret.
      const found = typeof node.value === "string" ? "another string" : jsonType(node.value);
      issues.push({
        code: "secret-value",
        path: node.segments.join("."),
        message: `is listed in secret, so it must be a string that is stored as ${placeholder} (found ${found})`,
      });
    }
    if (nodes.some((node) => volatileMode(volatile, node.segments).mode !== null)) {
      issues.push({
        code: "secret-volatile",
        path,
        message: `${key} is also covered by volatile (a placeholder does not change between runs)`,
      });
    }
  }
}

/**
 * What to do about a string that must not be stored, by where it is. A secret path names a
 * value in headers or in a body, and nothing else: a description, a name, the path of a
 * request or a pattern can only be worded differently.
 */
function wayOut(segments: readonly string[]): string {
  const [root, part] = segments;
  return (root === "request" || root === "response") &&
    (part === "headers" || part === "body") &&
    // A key that is empty or holds `.` or `*` cannot be written in a path.
    segments.every((segment) => segment !== "" && !segment.includes(".") && !segment.includes("*"))
    ? "(list this path in secret, so that a placeholder is stored instead)"
    : "(no secret path can name this place: change the text itself, or what the test passes)";
}

/** Every string of a fixture, with the keys and indexes that lead to it. */
function eachString(root: unknown, visit: (value: string, segments: string[]) => void): void {
  const walk = (node: unknown, segments: string[]): void => {
    if (typeof node === "string") visit(node, segments);
    else if (Array.isArray(node)) node.forEach((item, i) => walk(item, [...segments, String(i)]));
    else if (isObject(node)) for (const key of sortedKeys(node)) walk(node[key], [...segments, key]);
  };
  walk(root, []);
}

/** A token that was not replaced by a placeholder must not be written or stay stored. */
function validateNoJwt(issues: FormatIssue[], root: unknown): void {
  eachString(root, (value, segments) => {
    if (!JWT_PATTERN.test(value)) return;
    issues.push({
      code: "jwt",
      path: segments.join("."),
      message: `contains what looks like a JSON Web Token ${wayOut(segments)}`,
    });
  });
}

/** A string that the configuration of the directory forbids must not be written or stay stored. */
function validateNotForbidden(issues: FormatIssue[], root: unknown, forbidden: readonly CompiledPattern[]): void {
  if (forbidden.length === 0) return;
  eachString(root, (value, segments) => {
    forbidden.forEach((pattern, i) => {
      if (!pattern.search(value)) return;
      // The value itself is never printed: it may be the secret.
      issues.push({
        code: "forbidden",
        path: segments.join("."),
        message: `contains what forbidden.${i} of config.json describes ${wayOut(segments)}`,
      });
    });
  });
}

/**
 * Checks a parsed fixture against format 1. `name` is the file name without `.json`.
 * `config` is what the `config.json` of the contracts directory says (see `readConfig`).
 * Returns an empty array when the fixture is valid.
 */
export function validateFixtureValue(
  kind: Kind,
  name: string,
  value: unknown,
  config?: ContractsConfig,
): FormatIssue[] {
  const forbidden = (config?.forbidden ?? []).map(compilePattern);
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
  const roots = kind === "provider" ? ["request", "response"] : ["request"];
  if (Object.hasOwn(value, "volatile")) validateVolatile(issues, value, roots, forbidden);
  if (Object.hasOwn(value, "secret")) validateSecret(issues, value, roots);
  validateNumbers(issues, value);
  validateNoJwt(issues, value);
  validateNotForbidden(issues, value, forbidden);
  return issues;
}

/** Parses the text of a fixture file and checks it against format 1. */
export function validateFixture(
  kind: Kind,
  name: string,
  text: string,
  config?: ContractsConfig,
): { value: unknown; issues: FormatIssue[] } {
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch {
    return {
      value: undefined,
      issues: [{ code: "json", path: "(root)", message: "is not valid JSON" }],
    };
  }
  return { value, issues: validateFixtureValue(kind, name, value, config) };
}

/**
 * Reads a fixture file and checks it against format 1. The file must be UTF-8 (a byte order
 * mark is ignored); anything else is reported as the `json` issue.
 */
export function validateFixtureFile(
  kind: Kind,
  name: string,
  filePath: string,
  config?: ContractsConfig,
): { value: unknown; issues: FormatIssue[] } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return {
      value: undefined,
      issues: [{ code: "json", path: "(root)", message: "is not valid UTF-8" }],
    };
  }
  return validateFixture(kind, name, text, config);
}

export function formatIssues(issues: readonly FormatIssue[]): string {
  return issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
}
