import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readTarball, extractTarball } = require("../../cli/scripts/tarball.cjs");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-tar-fixture-"));
  roots.push(root);
  const source = path.join(root, "source");
  const modules = path.join(source, "package", "app", "_nm", "sql.js", "dist");
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(modules, "sql-wasm.wasm"), "fixture");
  fs.writeFileSync(path.join(source, "package", "package.json"), JSON.stringify({ name: "srouter", version: "0.16.0" }));
  const tarball = path.join(root, "srouter-0.16.0.tgz");
  // Creating via stdout avoids Windows drive-letter remote archive interpretation too.
  fs.writeFileSync(tarball, execFileSync("tar", ["-czf", "-", "package"], { cwd: source }));
  return { root, tarball };
}

describe("CLI cross-platform tarball reads", () => {
  it("lists and reads a manifest from an absolute archive path", () => {
    const { tarball } = fixture();
    expect(readTarball(tarball, ["-tz"], { encoding: "utf8" })).toContain("package/package.json");
    const manifest = readTarball(tarball, ["-xO", "package/package.json"], { encoding: "utf8" });
    expect(JSON.parse(manifest).version).toBe("0.16.0");
  });

  it("extracts a generated archive into cwd without -C path handling", () => {
    const { root, tarball } = fixture();
    const destination = path.join(root, "extract with spaces");
    fs.mkdirSync(destination);
    extractTarball(tarball, destination);
    expect(fs.readFileSync(path.join(destination, "package", "app", "_nm", "sql.js", "dist", "sql-wasm.wasm"), "utf8")).toBe("fixture");
  });

  it("runs the real package validator with the stdin archive contract", () => {
    const { tarball } = fixture();
    const validator = fileURLToPath(new URL("../../cli/scripts/validate-package.cjs", import.meta.url));
    const output = execFileSync(process.execPath, [validator, tarball, "0.16.0"], { encoding: "utf8" });
    expect(output).toContain("Validated srouter@0.16.0");
  });

  it.each(["archive", "installed"])("smoke-tests an %s fixture and imports the bundled browser without launch", (mode) => {
    const { root } = fixture();
    const packageDir = path.join(root, "source", "package");
    const appDir = path.join(packageDir, "app");
    const browserDir = path.join(appDir, "_nm", "playwright-core");
    fs.mkdirSync(browserDir, { recursive: true });
    fs.writeFileSync(path.join(browserDir, "index.js"),
      'module.exports = { chromium: { launch() { throw new Error("Browser must not launch"); } } };');
    fs.writeFileSync(path.join(appDir, "custom-server.js"), `
      const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
      const data = process.env.DATA_DIR;
      if (!JSON.parse(fs.readFileSync(path.join(data, "db.json"))).settings) process.exit(1);
      fs.mkdirSync(path.join(data, "db"), { recursive: true });
      fs.writeFileSync(path.join(data, "db", "data.sqlite"), "fixture");
      fs.writeFileSync(path.join(data, "db", ".migrated-from-json"), "fixture");
      http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url === "/api/version"
          ? { currentVersion: "0.16.0" } : { requireLogin: false }));
      }).listen(Number(process.env.PORT), "127.0.0.1");
    `);
    const tarball = path.join(root, "smoke-fixture.tgz");
    fs.writeFileSync(tarball, execFileSync("tar", ["-czf", "-", "package"], { cwd: path.join(root, "source") }));
    const smoke = fileURLToPath(new URL("../../cli/scripts/smoke-package.cjs", import.meta.url));
    const output = execFileSync(process.execPath, [
      smoke, mode === "installed" ? packageDir : tarball, "0.16.0",
    ], { encoding: "utf8", timeout: 15000 });
    expect(output).toContain(`${mode} server, version, browser import (no launch), SQLite, legacy migration`);
    expect(fs.existsSync(packageDir)).toBe(true);
  });
});
