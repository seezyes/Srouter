const { spawnSync } = require("child_process");
const path = require("path");

// Run ESLint with the project's main config but only fail on no-undef errors.
// This prevents "X is not defined" runtime crashes (like Issue #1 and the
// OpenCode CLI "res is not defined" bug) without blocking on pre-existing
// react-hooks/import/style violations.
//
// Srouter adaptations vs the VansRouter original:
//  - flat ESLint config (eslint.config.mjs) rejects the legacy `--ext` flag;
//  - the eslint CLI is spawned through the Node binary instead of
//    `./node_modules/.bin/eslint` (spawning the `.cmd` shim directly fails with
//    EINVAL on Windows, and the CI matrix builds on windows-latest);
//  - no `cli/_nm/**` tree exists here.
const eslintCli = path.join(__dirname, "..", "node_modules", "eslint", "bin", "eslint.js");

const result = spawnSync(
  process.execPath,
  [eslintCli, "src/", "open-sse/", "cli/", "--ignore-pattern", "cli/app/**", "--ignore-pattern", "cli/.build-home/**"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
);

const output = (result.stdout || "") + (result.stderr || "");
const lines = output.split("\n").filter((line) =>
  /no-undef|is not defined/.test(line)
);

if (lines.length) {
  console.error(lines.join("\n"));
  process.exit(1);
}

// Guard against silent no-ops: if ESLint itself failed (bad flags, crash),
// the filtered output is empty and the gate would report a fake "clean".
const looksLikeEslintFailure = result.error
  || /Invalid option|ESLint couldn't find|Error: Cannot find module/.test(output);
if (looksLikeEslintFailure) {
  console.error(output.trim() || String(result.error));
  process.exit(1);
}

console.log("no-undef lint: clean");
