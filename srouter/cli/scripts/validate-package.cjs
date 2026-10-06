#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { readTarball } = require("./tarball.cjs");

const [tarball, expectedVersion] = process.argv.slice(2);

if (!tarball || !expectedVersion) {
  throw new Error("Usage: validate-package.cjs <tarball> <version>");
}
if (!fs.existsSync(tarball)) {
  throw new Error(`Tarball does not exist: ${tarball}`);
}

// tar emits CRLF line endings on Windows, so strip the trailing CR before
// comparing entry names (CI runs on Linux, local release checks do not).
const entries = readTarball(tarball, ["-tz"], { encoding: "utf8" })
  .split(/\r?\n/)
  .map((entry) => entry.replace(/\r$/, ""))
  .filter(Boolean);
// The CLI keeps its traced runtime modules under app/node_modules (or app/_nm when
// the tree is renamed before packing). sql.js reads its WASM from disk at runtime, so
// output tracing alone does not guarantee the asset ships — assert it explicitly.
const wasmCandidates = [
  "package/app/node_modules/sql.js/dist/sql-wasm.wasm",
  "package/app/_nm/sql.js/dist/sql-wasm.wasm",
];
const requiredWasm = wasmCandidates.find((entry) => entries.includes(entry));

if (!requiredWasm) {
  throw new Error(
    `sql.js WASM missing from final CLI package (checked ${wasmCandidates.join(", ")})`,
  );
}
if (entries.some((entry) => /(^|\/)better_sqlite3\.node$/.test(entry))) {
  throw new Error("native better-sqlite3 leaked into final CLI package");
}

const packageJson = JSON.parse(readTarball(tarball, ["-xO", "package/package.json"], {
  encoding: "utf8",
}));
if (packageJson.name !== "srouter") {
  throw new Error(`Unexpected package name: ${packageJson.name}`);
}
if (packageJson.version !== expectedVersion) {
  throw new Error(`Tarball version mismatch: ${packageJson.version} !== ${expectedVersion}`);
}

const expectedFilename = `srouter-${expectedVersion}.tgz`;
if (path.basename(tarball) !== expectedFilename) {
  throw new Error(`Tarball filename mismatch: ${path.basename(tarball)} !== ${expectedFilename}`);
}

console.log(`Validated ${packageJson.name}@${packageJson.version} (${requiredWasm}): ${tarball}`);
