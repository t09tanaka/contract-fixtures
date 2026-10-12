import fs from "node:fs";
import path from "node:path";

import { isObject, sortedKeys } from "./json.js";
import { compilePattern, PatternError } from "./pattern.js";
import { FORMAT_VERSION } from "./types.js";
import type { FormatIssue } from "./validate.js";

/** The file of a contracts directory that holds what is particular to a project. */
export const CONFIG_FILE = "config.json";

/** What `<contracts>/config.json` says. Without the file, nothing. */
export interface ContractsConfig {
  /**
   * Patterns of strings that must not be in a fixture (credentials with a shape of their
   * own). A string is refused when a pattern matches anywhere in it.
   */
  forbidden: string[];
}

const KEYS = ["format", "forbidden"];

/**
 * Checks the text of a `config.json`. `config` is what it says when `issues` is empty, and
 * says nothing otherwise.
 */
export function validateConfig(text: string): { config: ContractsConfig; issues: FormatIssue[] } {
  const none: ContractsConfig = { forbidden: [] };
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
  } catch {
    return { config: none, issues: [{ code: "json", path: "(root)", message: "is not valid JSON" }] };
  }
  if (!isObject(value)) {
    return { config: none, issues: [{ code: "root", path: "(root)", message: "must be a JSON object" }] };
  }
  const issues: FormatIssue[] = [];
  for (const key of sortedKeys(value)) {
    if (!KEYS.includes(key)) {
      issues.push({ code: "unknown-key", path: key, message: `unknown key (allowed: ${KEYS.join(", ")})` });
    }
  }
  if (value.format !== FORMAT_VERSION) {
    issues.push({
      code: "format",
      path: "format",
      message: `must be ${FORMAT_VERSION} (this is the only format this version reads)`,
    });
  }
  const forbidden = Object.hasOwn(value, "forbidden") ? value.forbidden : [];
  if (!Array.isArray(forbidden)) {
    issues.push({ code: "forbidden", path: "forbidden", message: "must be an array of patterns" });
  } else {
    forbidden.forEach((pattern: unknown, i: number) => {
      if (typeof pattern !== "string") {
        issues.push({ code: "forbidden", path: `forbidden.${i}`, message: "must be a pattern (a string)" });
        return;
      }
      try {
        if (compilePattern(pattern).search("")) {
          issues.push({
            code: "pattern",
            path: `forbidden.${i}`,
            message: "matches the empty string, so it would forbid every string",
          });
        }
      } catch (error) {
        if (!(error instanceof PatternError)) throw error;
        issues.push({
          code: "pattern",
          path: `forbidden.${i}`,
          message: `is not a pattern this format supports: ${error.message}`,
        });
      }
    });
  }
  return issues.length > 0 ? { config: none, issues } : { config: { forbidden: forbidden as string[] }, issues };
}

/**
 * Reads `<dir>/config.json`. A directory without the file has a configuration that says
 * nothing. The file must be UTF-8 (a byte order mark is ignored), like a fixture.
 */
export function readConfig(dir: string): { config: ContractsConfig; issues: FormatIssue[] } {
  const file = path.join(dir, CONFIG_FILE);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat === undefined) return { config: { forbidden: [] }, issues: [] };
  if (!stat.isFile()) {
    return { config: { forbidden: [] }, issues: [{ code: "json", path: "(root)", message: "is not a file" }] };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return {
      config: { forbidden: [] },
      issues: [{ code: "json", path: "(root)", message: "is not valid UTF-8" }],
    };
  }
  return validateConfig(text);
}
