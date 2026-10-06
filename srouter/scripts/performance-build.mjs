import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

if (process.argv.includes("--help")) {
  console.log(`Usage: npm run bundle:analyze
Source-only webpack production bundle analysis (no server).
Creates a unique .next-analyze-<uuid> dist in this worktree and temporary DATA_DIR.
Never runs postbuild/copy/deploy, opens a browser, or changes running instances.
Reports: <dist>/analyze/{client,nodejs,edge}.html (where emitted).
Artifacts are kept for inspection; remove only your own generated directories.
Analyzer reports contain source/module paths; keep local.
Render profiling is NOT enabled in this production build.
For render profiling use SROUTER_RENDER_PROFILE=1 with an authorized source dev
launcher, then browser console: __SROUTER_RENDER_PROFILE__.summary(), snapshot(),
clear(), pause(), resume(). Never point dev at a production DATA_DIR.
Dev timings include StrictMode/HMR overhead; use Chrome Performance and React
DevTools Profiler to inspect component attribution and production interactions.`);
} else if (process.argv.length > 2) {
  throw new Error("Unknown arguments; use --help");
} else {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const dist = `.next-analyze-${randomUUID()}`;
  // Next adds each unique dist to its TS includes. Keep those edits out of the
  // developer's existing config; the copy stays adjacent for relative paths.
  const tsconfig = `${dist}.tsconfig.json`;
  if (existsSync(join(root, "tsconfig.json"))) {
    copyFileSync(join(root, "tsconfig.json"), join(root, tsconfig));
  } else if (existsSync(join(root, "jsconfig.json"))) {
    copyFileSync(join(root, "jsconfig.json"), join(root, tsconfig));
  } else {
    writeFileSync(join(root, tsconfig), JSON.stringify({
      compilerOptions: { allowJs: true, noEmit: true },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
      exclude: ["node_modules", "vendor/omniroute"],
    }, null, 2));
  }
  const data = mkdtempSync(join(tmpdir(), "srouter-bundle-analysis-"));
  console.log(`Source dist: ${join(root, dist)}\nTemporary DATA_DIR: ${data}`);
  const child = spawn(process.execPath, [
    join(root, "node_modules/next/dist/bin/next"), "build", "--webpack",
  ], {
    cwd: root, stdio: "inherit",
    env: {
      ...process.env, NODE_ENV: "production", NEXT_DIST_DIR: dist, DATA_DIR: data,
      NEXT_TELEMETRY_DISABLED: "1", SROUTER_BUNDLE_ANALYZE: "1",
      SROUTER_ANALYZE_TSCONFIG: tsconfig,
      SROUTER_RENDER_PROFILE: "0",
      // Do not inherit the dev credential-sharing policy into a source build.
      SROUTER_DEV_MIRROR_REFRESH: "0", SROUTER_DEV_AUTHORITATIVE_DB: "",
    },
  });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}
