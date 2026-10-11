// Builds dist/esm (ES modules, the default) and dist/cjs (for test runners that still
// load packages with require()).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

fs.rmSync("dist", { recursive: true, force: true });
for (const project of ["tsconfig.json", "tsconfig.cjs.json"]) {
  execFileSync(process.execPath, [tsc, "-p", project], { stdio: "inherit" });
}
fs.writeFileSync("dist/cjs/package.json", '{ "type": "commonjs" }\n');
