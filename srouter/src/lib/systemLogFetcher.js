import fs from "fs";
import path from "path";
import os from "os";
import { redactLogLine } from "@/shared/utils/requestDetailRedaction.js";

// Diagnostic log reader behind GET /api/translator/console-logs.
//
// The in-process console buffer only captures what the running Node process
// logs. Under PM2 / Docker the interesting startup and crash output lives in
// the supervisor's own log files, so the console-logs endpoint merges those
// sources instead of silently dropping them. Read-only: this module never
// writes, rotates or truncates any log file.
//
// Secrecy: every returned line passes through the shared log redactor
// (src/shared/utils/requestDetailRedaction.js) so bearer/access/refresh/session
// tokens, api keys and passwords never reach the diagnostics API. Timestamps,
// provider names and error text are preserved.
//
// Path safety: a log file is only read when its realpath (symlinks/junctions
// resolved) stays inside the configured root directory and it is a regular
// file. A symlink planted inside the logs directory cannot redirect the reader
// to an arbitrary file.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return typeof str === "string" ? str.replace(ANSI_RE, "") : "";
}

/**
 * Resolve `filePath` and return it only when it is a regular file whose real
 * path is inside `rootDir`. Symlinks and Windows junctions are resolved before
 * the check, so a link planted in the logs directory cannot escape the root.
 * Returns null when the file is missing, not a regular file, or outside root.
 *
 * @param {string} filePath
 * @param {string} rootDir
 * @returns {string|null}
 */
export function resolveLogFileWithinRoot(filePath, rootDir) {
  try {
    const realRoot = fs.realpathSync(rootDir);
    const realFile = fs.realpathSync(filePath);
    const relative = path.relative(realRoot, realFile);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (!fs.statSync(realFile).isFile()) return null;
    return realFile;
  } catch {
    return null;
  }
}

/**
 * Read the tail of a file, capped by bytes and lines. Never throws.
 * Every returned line is credential-redacted.
 *
 * @param {string} filePath
 * @param {number} [maxBytes]
 * @param {number} [maxLines]
 * @param {{ rootDir?: string }} [options] when rootDir is given the file is
 *        only read if its realpath stays inside that directory.
 * @returns {string[]}
 */
export function readTailLines(filePath, maxBytes = 256 * 1024, maxLines = 300, options = {}) {
  try {
    let target = filePath;
    if (options && options.rootDir) {
      target = resolveLogFileWithinRoot(filePath, options.rootDir);
      if (!target) return [];
    }

    if (!fs.existsSync(target)) return [];
    const stat = fs.statSync(target);
    if (stat.size === 0 || !stat.isFile()) return [];

    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);

    const fd = fs.openSync(target, "r");
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    } finally {
      fs.closeSync(fd);
    }

    const content = stripAnsi(buffer.toString("utf8"));
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).map((line) => redactLogLine(line));
  } catch (err) {
    return [redactLogLine(`[PM2 Reader Error] ${err.message}`)];
  }
}

/**
 * Fetch PM2 logs (error + stdout) for the router process. Returns
 * `available:false` with a reason when no PM2 log directory exists.
 * @param {number} [maxLinesPerFile]
 */
export function getPm2Logs(maxLinesPerFile = 200) {
  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
  const pm2LogsDir = path.join(pm2Home, "logs");

  if (!fs.existsSync(pm2LogsDir)) {
    return {
      available: false,
      reason: `PM2 log directory not found at ${pm2LogsDir}`,
      errorLogs: [],
      outLogs: [],
      combined: [],
    };
  }

  let errorLogFile = null;
  let outLogFile = null;

  try {
    const files = fs.readdirSync(pm2LogsDir);
    const isOutFile = (f) => f.includes("output") || /(^|[-_.])out([-_.]|$)/.test(f);
    for (const f of files) {
      const named = f.includes("9router") || f.includes("router") || f.includes("srouter");
      // Resolve through the root guard: a symlink/junction planted here must not
      // redirect the reader outside <PM2_HOME>/logs.
      const resolved = resolveLogFileWithinRoot(path.join(pm2LogsDir, f), pm2LogsDir);
      if (!resolved) continue;
      if (!errorLogFile && named && f.includes("error")) {
        errorLogFile = resolved;
      }
      // NOTE: plain `f.includes("out")` is wrong — "router" itself contains
      // "out", so the error log gets classified as the stdout log. Match an
      // `out` token instead.
      if (!outLogFile && named && isOutFile(f)) {
        outLogFile = resolved;
      }
    }

    if (!errorLogFile) {
      errorLogFile = resolveLogFileWithinRoot(path.join(pm2LogsDir, "9router-error.log"), pm2LogsDir);
    }
    if (!outLogFile) {
      outLogFile = resolveLogFileWithinRoot(path.join(pm2LogsDir, "9router-out.log"), pm2LogsDir);
    }
  } catch {
    // Ignore read errors — availability is decided by the file flags below.
  }

  const rawErrorLines = errorLogFile
    ? readTailLines(errorLogFile, 512 * 1024, maxLinesPerFile, { rootDir: pm2LogsDir })
    : [];
  const rawOutLines = outLogFile
    ? readTailLines(outLogFile, 512 * 1024, maxLinesPerFile, { rootDir: pm2LogsDir })
    : [];

  const errorLogs = rawErrorLines.map((line) => {
    if (line.includes("[PM2]") || line.includes("[ERROR]")) return line;
    return `[PM2-ERROR] ${line}`;
  });

  const outLogs = rawOutLines.map((line) => {
    if (line.includes("[PM2]") || line.includes("[INFO]")) return line;
    return `[PM2-OUT] ${line}`;
  });

  return {
    available: !!(errorLogFile || outLogFile),
    errorLogFile,
    outLogFile,
    errorLogs,
    outLogs,
    combined: [...errorLogs, ...outLogs].slice(-maxLinesPerFile * 2),
  };
}

/**
 * Fetch Docker / container log files when running inside a container or when a
 * `<DATA_DIR>/logs` directory exists. Never throws.
 * @param {number} [maxLines]
 */
export function getDockerLogs(maxLines = 200) {
  const dataDir = process.env.DATA_DIR || "/app/data";
  const dockerLogDir = path.join(dataDir, "logs");
  const isDocker = fs.existsSync("/.dockerenv") || process.env.DATA_DIR === "/app/data";

  if (!isDocker && !fs.existsSync(dockerLogDir)) {
    return { isDocker: false, available: false, logs: [] };
  }

  const logs = [];
  if (fs.existsSync(dockerLogDir)) {
    try {
      const files = fs.readdirSync(dockerLogDir).filter((f) => f.endsWith(".log"));
      for (const f of files) {
        // Root-guarded: symlinks/junctions inside <DATA_DIR>/logs cannot point
        // the reader at a file outside the eligible log directory.
        const resolved = resolveLogFileWithinRoot(path.join(dockerLogDir, f), dockerLogDir);
        if (!resolved) continue;
        const lines = readTailLines(resolved, 256 * 1024, Math.max(1, Math.floor(maxLines / 2)), {
          rootDir: dockerLogDir,
        });
        logs.push(...lines.map((l) => `[DOCKER:${f.replace(".log", "")}] ${l}`));
      }
    } catch {
      // Ignore read errors.
    }
  }

  return {
    isDocker,
    available: logs.length > 0,
    logs: logs.slice(-maxLines),
  };
}
