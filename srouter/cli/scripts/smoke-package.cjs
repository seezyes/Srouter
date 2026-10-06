#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { extractTarball } = require("./tarball.cjs");

const [tarball, expectedVersion] = process.argv.slice(2);
if (!tarball || !expectedVersion) {
  throw new Error("Usage: smoke-package.cjs <tarball-or-installed-directory> <version>");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-release-"));
const dataDir = path.join(root, "data");
const port = 43000 + (process.pid % 1000);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "db.json"), JSON.stringify({
  settings: { requireLogin: false },
}));
const installedDirectory = fs.statSync(tarball).isDirectory() ? path.resolve(tarball) : null;
if (!installedDirectory) extractTarball(tarball, root);

const packageDir = installedDirectory || path.join(root, "package");
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
if (manifest.name !== "srouter" || manifest.version !== expectedVersion) {
  throw new Error("Packaged CLI name or version differs from the expected manifest");
}
const appDir = path.join(packageDir, "app");
// Bundled runtime modules live in app/node_modules (or app/_nm after a publish-safe
// rename); spawn the server against whichever layout the tarball actually ships.
const bundledModules = fs.existsSync(path.join(appDir, "_nm"))
  ? path.join(appDir, "_nm")
  : path.join(appDir, "node_modules");
const serverPath = fs.existsSync(path.join(appDir, "custom-server.js"))
  ? path.join(appDir, "custom-server.js")
  : path.join(appDir, "server.js");
if (!fs.existsSync(serverPath)) throw new Error(`Bundled server missing: ${serverPath}`);

let output = "";
const child = spawn(process.execPath, [serverPath], {
  cwd: appDir,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    NODE_PATH: [bundledModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
let spawnError = null;
child.on("error", (error) => { spawnError = error; });
const closed = new Promise((resolve) => child.once("close", resolve));

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(1000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
  });
}

async function waitForSettings() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Bundled server stopped before readiness:\n${output}`, { cause: spawnError });
    }
    try {
      const response = await request("/api/settings");
      if (response.status === 200) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Bundled server did not initialize in time:\n${output}`);
}

async function main() {
  try {
    const response = await waitForSettings();
    const settings = JSON.parse(response.body);
    if (settings.requireLogin !== false) {
      throw new Error(`Legacy db.json was not migrated: ${response.body}`);
    }
    const version = await request("/api/version");
    if (version.status !== 200 || JSON.parse(version.body).currentVersion !== expectedVersion) {
      throw new Error("Bundled server version differs from the expected package");
    }
    const browser = require(path.join(bundledModules, "playwright-core"));
    if (typeof browser.chromium?.launch !== "function") {
      throw new Error("Bundled browser runtime is incomplete");
    }

    // sql.js persists on a short debounce after writes; observe the durable file,
    // not only the in-memory HTTP response.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const dbFile = path.join(dataDir, "db", "data.sqlite");
    const marker = path.join(dataDir, "db", ".migrated-from-json");
    if (!fs.existsSync(dbFile)) throw new Error(`SQLite database missing: ${dbFile}`);
    if (!fs.existsSync(marker)) throw new Error(`Migration marker missing: ${marker}`);
    console.log(`Smoke-tested srouter@${expectedVersion}: ${installedDirectory ? "installed" : "archive"} server, version, browser import (no launch), SQLite, legacy migration`);
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await closed; } finally { clearTimeout(timer); }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
