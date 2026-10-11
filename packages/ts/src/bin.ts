#!/usr/bin/env node
import { runCli } from "./cli.js";

process.exitCode = runCli(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  env: process.env,
});
