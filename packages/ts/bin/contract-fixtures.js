#!/usr/bin/env node
import process from "node:process";

import { runCli } from "../dist/esm/cli.js";

process.exitCode = runCli(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  env: process.env,
});
