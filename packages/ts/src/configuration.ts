import fs from "node:fs";
import path from "node:path";

import { ContractUsageError } from "./errors.js";
import { isObject, sortedKeys } from "./json.js";
import { compilePattern, PatternError } from "./pattern.js";
import { FORMAT_VERSION, type Kind } from "./types.js";
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
  /**
   * The readers of the directory, by name: the consumers that each have a ledger of their
   * own. Without a declaration, none.
   */
  readers: Record<string, ReaderConfig>;
}

/** What one reader reads. A kind that is left out means every fixture of that kind. */
export interface ReaderConfig {
  /** The provider fixtures the reader reads: names, or the start of names followed by `*`. */
  provider?: string[];
  /** The tables the reader reads, written the same way. */
  tables?: string[];
}

const KEYS = ["format", "forbidden", "readers"];
const READER_KEYS = ["provider", "tables"] as const;

/** The name of a reader. Lower case only, so that two names never differ only in case. */
export const READER_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** An entry of a reader: the name of a fixture, or the start of names followed by `*`. */
const ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\*?$/;

/** Whether an entry of a reader names the fixture `name`. */
export function entryNames(entry: string, name: string): boolean {
  return entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name;
}

/** The names of the readers a configuration declares, sorted. */
export function declaredReaders(config: ContractsConfig): string[] {
  return sortedKeys(config.readers);
}

/**
 * Whether the fixture `<kind>/<name>.json` is one that `reader` has to verify or read.
 * Without a reader, every fixture is. The consumer fixtures of a reader are those whose
 * name starts with the name of the reader and a dot.
 */
export function readerTakes(config: ContractsConfig, reader: string | undefined, kind: Kind, name: string): boolean {
  if (reader === undefined) return true;
  if (kind === "consumer") return name.startsWith(`${reader}.`);
  const entries = Object.hasOwn(config.readers, reader) ? config.readers[reader]![kind] : undefined;
  return entries === undefined || entries.some((entry) => entryNames(entry, name));
}

/**
 * Fails unless `reader` can be the reader of a consumer in a directory with this
 * configuration: where readers are declared, it is one of them.
 */
export function requireDeclaredReader(config: ContractsConfig, reader: string | undefined): void {
  const declared = declaredReaders(config);
  if (declared.length === 0 || (reader !== undefined && declared.includes(reader))) return;
  throw new ContractUsageError(
    reader === undefined
      ? `contract-fixtures: ${CONFIG_FILE} declares readers (${declared.join(", ")}): say which one this is`
      : `contract-fixtures: ${CONFIG_FILE} declares no reader named ${reader} (declared: ${declared.join(", ")})`,
  );
}

function validateReaders(value: unknown, issues: FormatIssue[]): Record<string, ReaderConfig> {
  const readers: Record<string, ReaderConfig> = {};
  if (!isObject(value) || Object.keys(value).length === 0) {
    issues.push({ code: "readers", path: "readers", message: "must be an object that names at least one reader" });
    return readers;
  }
  for (const name of sortedKeys(value)) {
    const at = `readers.${name}`;
    const reads = value[name];
    if (!READER_PATTERN.test(name)) {
      issues.push({ code: "readers", path: at, message: "is not the name of a reader (lower-case letters, digits and -)" });
      continue;
    }
    if (!isObject(reads)) {
      issues.push({ code: "readers", path: at, message: "must be an object (empty for a reader that reads everything)" });
      continue;
    }
    for (const key of sortedKeys(reads)) {
      if (!(READER_KEYS as readonly string[]).includes(key)) {
        issues.push({ code: "unknown-key", path: `${at}.${key}`, message: `unknown key (allowed: ${READER_KEYS.join(", ")})` });
      }
    }
    const reader: ReaderConfig = {};
    for (const key of READER_KEYS) {
      if (!Object.hasOwn(reads, key)) continue;
      const entries: unknown = reads[key];
      if (!Array.isArray(entries)) {
        issues.push({ code: "readers", path: `${at}.${key}`, message: "must be an array of fixture names" });
        continue;
      }
      entries.forEach((entry: unknown, i: number) => {
        if (typeof entry !== "string" || !ENTRY_PATTERN.test(entry)) {
          issues.push({
            code: "readers",
            path: `${at}.${key}.${i}`,
            message: "must be the name of a fixture, or the start of names followed by *",
          });
        }
      });
      reader[key] = entries as string[];
    }
    readers[name] = reader;
  }
  return readers;
}

/**
 * Checks the text of a `config.json`. `config` is what it says when `issues` is empty, and
 * says nothing otherwise.
 */
export function validateConfig(text: string): { config: ContractsConfig; issues: FormatIssue[] } {
  const none: ContractsConfig = { forbidden: [], readers: {} };
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
  const readers = Object.hasOwn(value, "readers") ? validateReaders(value.readers, issues) : {};
  return issues.length > 0
    ? { config: none, issues }
    : { config: { forbidden: forbidden as string[], readers }, issues };
}

/**
 * Reads `<dir>/config.json`. A directory without the file has a configuration that says
 * nothing. The file must be UTF-8 (a byte order mark is ignored), like a fixture.
 */
export function readConfig(dir: string): { config: ContractsConfig; issues: FormatIssue[] } {
  const file = path.join(dir, CONFIG_FILE);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  const none: ContractsConfig = { forbidden: [], readers: {} };
  if (stat === undefined) return { config: none, issues: [] };
  if (!stat.isFile()) {
    return { config: none, issues: [{ code: "json", path: "(root)", message: "is not a file" }] };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { config: none, issues: [{ code: "json", path: "(root)", message: "is not valid UTF-8" }] };
  }
  return validateConfig(text);
}
