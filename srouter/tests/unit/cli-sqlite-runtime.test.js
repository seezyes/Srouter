import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildEnvWithRuntime, getRuntimeNodeModules } = require("../../cli/hooks/sqliteRuntime.js");

const cliAppDir = fileURLToPath(new URL("../../cli/app", import.meta.url));

// The packaged CLI keeps its traced runtime modules under app/node_modules and may
// rename them to app/_nm before packing; both layouts must stay resolvable.
function bundledModulesDir() {
  return fs.existsSync(path.join(cliAppDir, "_nm"))
    ? path.join(cliAppDir, "_nm")
    : path.join(cliAppDir, "node_modules");
}

function bundledWasmPaths() {
  return ["_nm", "node_modules"].map((nodeModules) =>
    path.join(cliAppDir, nodeModules, "sql.js", "dist", "sql-wasm.wasm"),
  );
}

describe("CLI SQLite runtime packaging", () => {
  it("keeps the bundled and user runtime module paths available", () => {
    const env = buildEnvWithRuntime({ NODE_PATH: "existing-path" });
    const paths = env.NODE_PATH.split(path.delimiter);

    const bundledPath = bundledModulesDir();
    const runtimePath = getRuntimeNodeModules();
    expect(paths).toContain(bundledPath);
    expect(paths).toContain(runtimePath);
    expect(paths).toContain("existing-path");

    // The bundled tree wins only when its WASM asset actually shipped; a pruned
    // bundle must not shadow the runtime install.
    if (bundledWasmPaths().some((file) => fs.existsSync(file))) {
      expect(paths.indexOf(bundledPath)).toBeLessThan(paths.indexOf(runtimePath));
    } else {
      expect(paths.indexOf(runtimePath)).toBeLessThan(paths.indexOf(bundledPath));
    }
  });

  it("publishes the sql.js runtime through the CLI allowlist and the package validator", () => {
    const npmignore = fs.readFileSync(new URL("../../cli/.npmignore", import.meta.url), "utf8");
    expect(npmignore).toContain("!app/");

    const validator = fs.readFileSync(
      new URL("../../cli/scripts/validate-package.cjs", import.meta.url),
      "utf8",
    );
    expect(validator).toContain("sql-wasm.wasm");
    expect(validator).toContain("better_sqlite3");
  });
});
