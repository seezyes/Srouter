import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  ensureModuleInBundle,
  stripBundledPackage,
  copyRecursive,
} = require("../../cli/scripts/build-cli.js");

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Creates a directory link in a Windows-safe way. On Windows, directory symlinks
 * require SeCreateSymbolicLinkPrivilege, whereas junctions work without elevation.
 */
function createDirLink(target, link) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("build-helpers", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-helpers-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("guards the sql.js bundle with its WASM asset and strips native better-sqlite3", () => {
    const buildCli = fs.readFileSync(path.join(repoRoot, "cli/scripts/build-cli.js"), "utf8");
    expect(buildCli).toMatch(
      /ensureModuleInBundle\s*\(\s*["']sql\.js["'][\s\S]*?requiredFiles:\s*\[\s*["']dist\/sql-wasm\.wasm["']\s*\]/,
    );
    expect(buildCli).toMatch(/ensureModuleInBundle\s*\(\s*["']open["']/);
    expect(buildCli).toMatch(/stripBundledPackage\s*\(\s*cliAppDir\s*,\s*["']better-sqlite3["']\s*\)/);
  });

  it("declares the modules the bundle guard copies in root dependencies", () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(rootPkg.dependencies).toHaveProperty("sql.js");
    expect(rootPkg.dependencies).toHaveProperty("open");
    expect(rootPkg.dependencies).toHaveProperty("playwright-core");
  });

  it("copies the whole browser runtime even when tracing already created a package directory", () => {
    const appDir = path.join(tmpDir, "source");
    const cliAppDir = path.join(tmpDir, "bundle");
    const source = path.join(appDir, "node_modules", "playwright-core");
    const destination = path.join(cliAppDir, "node_modules", "playwright-core");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), '{"name":"playwright-core"}');
    fs.writeFileSync(path.join(source, "browsers.json"), '{"browsers":[]}');
    fs.writeFileSync(path.join(destination, "package.json"), '{"name":"playwright-core"}');
    ensureModuleInBundle("playwright-core", {
      appDir, cliAppDir, rootDir: tmpDir, completePackage: true,
    });
    expect(fs.existsSync(path.join(destination, "browsers.json"))).toBe(true);
    const buildCli = fs.readFileSync(path.join(repoRoot, "cli/scripts/build-cli.js"), "utf8");
    expect(buildCli).toMatch(/ensureModuleInBundle\("playwright-core",[^;]+completePackage: true/);
    for (const pkg of ["@next/env", "@swc/helpers", "react", "react-dom"]) {
      expect(buildCli).toContain(`"${pkg}"`);
    }
  });

  it("copies a package into the bundle node_modules from the candidate path", () => {
    const appDir = path.join(tmpDir, "app");
    const rootDir = path.join(tmpDir, "root");
    const cliAppDir = path.join(tmpDir, "cli", "app");
    const pkgDir = path.join(appDir, "node_modules", "@swc", "helpers");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@swc/helpers", version: "0.5.0" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");

    ensureModuleInBundle("@swc/helpers", { cliAppDir, appDir, rootDir, copyRecursive });

    const destDir = path.join(cliAppDir, "node_modules", "@swc", "helpers");
    expect(fs.existsSync(path.join(destDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "index.js"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(destDir, "package.json"), "utf8")).name).toBe("@swc/helpers");
  });

  it("copies dependency closure even when tracing already copied the root manifest", () => {
    const appDir = path.join(tmpDir, "source");
    const cliAppDir = path.join(tmpDir, "bundle");
    const root = path.join(appDir, "node_modules", "fixture-root");
    const child = path.join(root, "node_modules", "fixture-child");
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "fixture-root", dependencies: { "fixture-child": "1" },
    }));
    fs.writeFileSync(path.join(child, "package.json"), JSON.stringify({
      name: "fixture-child", dependencies: { "fixture-root": "1" },
    }));
    fs.writeFileSync(path.join(child, "index.js"), "module.exports = 'closure';");
    const traced = path.join(cliAppDir, "node_modules", "fixture-root");
    fs.mkdirSync(traced, { recursive: true });
    fs.copyFileSync(path.join(root, "package.json"), path.join(traced, "package.json"));
    ensureModuleInBundle("fixture-root", {
      appDir, rootDir: tmpDir, cliAppDir, includeDependencies: true,
    });
    expect(fs.readFileSync(path.join(cliAppDir, "node_modules", "fixture-child", "index.js"), "utf8"))
      .toContain("closure");
  });

  it("rejects a missing dependency instead of emitting an incomplete package", () => {
    const appDir = path.join(tmpDir, "source");
    const root = path.join(appDir, "node_modules", "fixture-root");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "fixture-root", dependencies: { "srouter-nonexistent-fixture": "1" },
    }));
    expect(() => ensureModuleInBundle("fixture-root", {
      appDir, rootDir: tmpDir, cliAppDir: path.join(tmpDir, "bundle"), includeDependencies: true,
    })).toThrow("srouter-nonexistent-fixture");
  });

  it("copies a package from a pnpm-like virtual-store layout into the bundle node_modules", () => {
    const appDir = path.join(tmpDir, "app");
    const rootDir = path.join(tmpDir, "root");
    const cliAppDir = path.join(tmpDir, "cli", "app");
    const virtualStoreDir = path.join(
      appDir,
      "node_modules",
      ".pnpm",
      "@swc+helpers@0.5.0",
      "node_modules",
      "@swc",
      "helpers",
    );
    fs.mkdirSync(virtualStoreDir, { recursive: true });
    fs.writeFileSync(
      path.join(virtualStoreDir, "package.json"),
      JSON.stringify({ name: "@swc/helpers", version: "0.5.0" }),
    );
    fs.writeFileSync(path.join(virtualStoreDir, "index.js"), "module.exports = {};");

    // pnpm creates a symlink at app/node_modules/@swc/helpers pointing into the virtual store.
    const pkgLinkDir = path.join(appDir, "node_modules", "@swc");
    fs.mkdirSync(pkgLinkDir, { recursive: true });
    createDirLink(path.relative(pkgLinkDir, virtualStoreDir), path.join(pkgLinkDir, "helpers"));

    ensureModuleInBundle("@swc/helpers", { cliAppDir, appDir, rootDir, copyRecursive });

    const destDir = path.join(cliAppDir, "node_modules", "@swc", "helpers");
    expect(fs.existsSync(path.join(destDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "index.js"))).toBe(true);
    expect(fs.lstatSync(destDir).isSymbolicLink()).toBe(false);
  });

  it("falls back to require.resolve when the package is not in the direct candidate paths", () => {
    const appDir = path.join(tmpDir, "app");
    const rootDir = appDir;
    const cliAppDir = path.join(tmpDir, "cli", "app");
    // Package lives in an ancestor node_modules directory so direct candidates miss but
    // Node's module resolver walks up and finds it.
    const pkgDir = path.join(tmpDir, "node_modules", "@swc", "helpers");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@swc/helpers", version: "0.5.0" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");

    ensureModuleInBundle("@swc/helpers", { cliAppDir, appDir, rootDir, copyRecursive });

    const destDir = path.join(cliAppDir, "node_modules", "@swc", "helpers");
    expect(fs.existsSync(path.join(destDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "index.js"))).toBe(true);
  });

  it("is a no-op when the package is already present in the bundle", () => {
    const appDir = path.join(tmpDir, "app");
    const rootDir = path.join(tmpDir, "root");
    const cliAppDir = path.join(tmpDir, "cli", "app");
    const destDir = path.join(cliAppDir, "node_modules", "@swc", "helpers");
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(
      path.join(destDir, "package.json"),
      JSON.stringify({ name: "@swc/helpers", version: "0.5.0" }),
    );

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    ensureModuleInBundle("@swc/helpers", { cliAppDir, appDir, rootDir, copyRecursive });
    spy.mockRestore();

    expect(fs.readdirSync(destDir)).toEqual(["package.json"]);
  });

  it("copies a package again when a required asset is missing", () => {
    const appDir = path.join(tmpDir, "app");
    const rootDir = path.join(tmpDir, "root");
    const cliAppDir = path.join(tmpDir, "cli", "app");
    const sourceDir = path.join(appDir, "node_modules", "sql.js");
    const destDir = path.join(cliAppDir, "node_modules", "sql.js");
    fs.mkdirSync(path.join(sourceDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(destDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "package.json"), JSON.stringify({ name: "sql.js" }));
    fs.writeFileSync(path.join(sourceDir, "dist", "sql-wasm.wasm"), "wasm");
    fs.writeFileSync(path.join(destDir, "package.json"), JSON.stringify({ name: "sql.js" }));

    ensureModuleInBundle("sql.js", {
      cliAppDir,
      appDir,
      rootDir,
      copyRecursive,
      requiredFiles: ["dist/sql-wasm.wasm"],
    });

    expect(fs.readFileSync(path.join(destDir, "dist", "sql-wasm.wasm"), "utf8")).toBe("wasm");
  });

  it("strips direct and pnpm virtual-store package copies", () => {
    const cliAppDir = path.join(tmpDir, "cli", "app");
    const direct = path.join(cliAppDir, "node_modules", "better-sqlite3");
    const virtual = path.join(
      cliAppDir,
      "node_modules",
      ".pnpm",
      "better-sqlite3@1",
      "node_modules",
      "better-sqlite3",
    );
    const renamedVirtual = path.join(
      cliAppDir,
      "_nm",
      ".pnpm",
      "better-sqlite3@2",
      "node_modules",
      "better-sqlite3",
    );
    fs.mkdirSync(direct, { recursive: true });
    fs.mkdirSync(virtual, { recursive: true });
    fs.mkdirSync(renamedVirtual, { recursive: true });

    expect(stripBundledPackage(cliAppDir, "better-sqlite3")).toBe(true);
    expect(fs.existsSync(direct)).toBe(false);
    expect(fs.existsSync(virtual)).toBe(false);
    expect(fs.existsSync(renamedVirtual)).toBe(false);
  });

  it("refuses an incomplete bundle when the package cannot be resolved", () => {
    const appDir = path.join(tmpDir, "app");
    const rootDir = path.join(tmpDir, "root");
    const cliAppDir = path.join(tmpDir, "cli", "app");
    const missingPkg = "@swc/helpers-does-not-exist-xyz123";

    expect(() => ensureModuleInBundle(missingPkg, { cliAppDir, appDir, rootDir, copyRecursive }))
      .toThrow(`${missingPkg} not found locally`);
  });
});
