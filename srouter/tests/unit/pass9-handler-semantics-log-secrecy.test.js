// Pass9 handler-semantics closure — diagnostics log secrecy and path confinement.
//
// Contract under test (src/lib/systemLogFetcher.js + the shared redactor in
// src/shared/utils/requestDetailRedaction.js):
//   1. Every line returned by the PM2/Docker log readers is credential-redacted:
//      bearer/access/refresh/session tokens, api keys and passwords never reach
//      the diagnostics API, while timestamps/provider names/error text survive.
//   2. A log file is only read when its realpath stays inside the configured
//      logs root and it is a regular file — a symlink or Windows junction
//      planted inside the logs directory cannot redirect the reader outside it.
//
// All secrets here are synthetic and deterministic; no real credential, DB,
// network call, process or user data is involved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  getConsoleLogs: vi.fn(),
  clearConsoleLogs: vi.fn(),
  initConsoleLogCapture: vi.fn(),
}));

vi.mock("@/lib/consoleLogBuffer", () => ({
  getConsoleLogs: mocks.getConsoleLogs,
  clearConsoleLogs: mocks.clearConsoleLogs,
  initConsoleLogCapture: mocks.initConsoleLogCapture,
}));

import { redactLogLine, redactLogLines } from "@/shared/utils/requestDetailRedaction.js";
import {
  getDockerLogs,
  getPm2Logs,
  readTailLines,
  resolveLogFileWithinRoot,
} from "@/lib/systemLogFetcher.js";

const SYNTHETIC_SECRETS = [
  "Bearer FAKE-BEARER-TOKEN-0123456789",
  "FAKE-BEARER-TOKEN-0123456789",
  "sk-live-FAKEFAKEFAKEFAKE",
  "sk-ant-api03-FAKEFAKEFAKEFAKE",
  "ya29.FAKE-ACCESS-TOKEN",
  "1//0FAKE-REFRESH-TOKEN",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKE-SIGNATURE-1234567890",
  "hunter2-FAKE-PASSWORD",
  "ghp_FAKEFAKEFAKEFAKE1234567890",
  "AIzaFAKEFAKEFAKEFAKE123456789012345",
  "FAKE-SESSION-TOKEN-VALUE",
  "FAKE-CLIENT-SECRET-VALUE",
];

const SECRET_LINES = [
  "2026-10-02T09:15:00.123Z INFO provider=gemini-cli request started",
  "Authorization: Bearer FAKE-BEARER-TOKEN-0123456789",
  'x-api-key: sk-live-FAKEFAKEFAKEFAKE',
  '{"access_token":"ya29.FAKE-ACCESS-TOKEN","refresh_token":"1//0FAKE-REFRESH-TOKEN","expires_in":3599}',
  "set-cookie: srouter_auth_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKE-SIGNATURE-1234567890; Path=/; HttpOnly",
  "password=hunter2-FAKE-PASSWORD",
  "token=ghp_FAKEFAKEFAKEFAKE1234567890",
  "GOOGLE_API_KEY=AIzaFAKEFAKEFAKEFAKE123456789012345",
  "session_token: FAKE-SESSION-TOKEN-VALUE",
  "client_secret: FAKE-CLIENT-SECRET-VALUE",
  "GET /api/v1/models 200 in 42ms provider=openai",
];

let root;
let prevPm2Home;
let prevDataDir;

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pass9-logsecrecy-"));
  prevPm2Home = process.env.PM2_HOME;
  prevDataDir = process.env.DATA_DIR;
});

afterEach(() => {
  if (prevPm2Home === undefined) delete process.env.PM2_HOME;
  else process.env.PM2_HOME = prevPm2Home;
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function assertNoSecrets(text) {
  for (const secret of SYNTHETIC_SECRETS) {
    expect(text, `leaked: ${secret}`).not.toContain(secret);
  }
}

function tryFileSymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

function tryDirLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

describe("shared log redactor", () => {
  it("masks bearer/access/refresh/session tokens, api keys and passwords", () => {
    const out = redactLogLines(SECRET_LINES).join("\n");
    assertNoSecrets(out);
    expect(out).toContain("[REDACTED]");
  });

  it("keeps timestamps, provider names, status codes and error text useful", () => {
    const out = redactLogLines([
      "2026-10-02T09:15:00.123Z ERROR provider=antigravity upstream responded 429 too many requests",
      "2026-10-02T09:15:01.000Z WARN headroom proxy exited (code=1) — see proxy.log",
    ]);
    expect(out[0]).toBe("2026-10-02T09:15:00.123Z ERROR provider=antigravity upstream responded 429 too many requests");
    expect(out[1]).toContain("headroom proxy exited (code=1)");
  });

  it("is a no-op on ordinary lines and non-string input", () => {
    expect(redactLogLine("plain line without credentials")).toBe("plain line without credentials");
    expect(redactLogLine(undefined)).toBe("");
    expect(redactLogLines(null)).toEqual([]);
  });
});

describe("readTailLines redaction", () => {
  it("redacts secrets from a real file while keeping the surrounding text", () => {
    const file = path.join(root, "app-out.log");
    fs.writeFileSync(file, SECRET_LINES.join("\n"), "utf8");
    const lines = readTailLines(file, 64 * 1024, 50);
    const text = lines.join("\n");
    assertNoSecrets(text);
    expect(text).toContain("provider=gemini-cli request started");
    expect(text).toContain("provider=openai");
  });
});

describe("getPm2Logs path confinement and redaction", () => {
  it("reads and redacts the router error/out logs", () => {
    const logsDir = path.join(root, "pm2logs", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "9router-error.log"), "E1 password=hunter2-FAKE-PASSWORD\n", "utf8");
    fs.writeFileSync(path.join(logsDir, "9router-out.log"), "O1 Authorization: Bearer FAKE-BEARER-TOKEN-0123456789\n", "utf8");
    process.env.PM2_HOME = path.join(root, "pm2logs");

    const result = getPm2Logs(50);
    expect(result.available).toBe(true);
    const text = JSON.stringify(result);
    assertNoSecrets(text);
    expect(text).toContain("[PM2-OUT]");
  });

  it("refuses a symlinked log that resolves outside the logs root", () => {
    const logsDir = path.join(root, "linked", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const secretFile = path.join(root, "outside-secret.txt");
    fs.writeFileSync(secretFile, "OUTSIDE-SECRET-CONTENT password=hunter2-FAKE-PASSWORD\n", "utf8");

    const linkPath = path.join(logsDir, "9router-out.log");
    if (!tryFileSymlink(secretFile, linkPath)) {
      // Windows without developer mode cannot create file symlinks; the
      // directory-junction case below covers the same realpath guard.
      expect(resolveLogFileWithinRoot(secretFile, logsDir)).toBeNull();
      return;
    }

    process.env.PM2_HOME = path.join(root, "linked");
    const result = getPm2Logs(50);
    expect(JSON.stringify(result)).not.toContain("OUTSIDE-SECRET-CONTENT");
    expect(getPm2Logs(50).outLogs).toEqual([]);
  });

  it("rejects a junction that escapes the root and accepts a real file inside it", () => {
    const logsDir = path.join(root, "junction-logs", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const outsideDir = path.join(root, "outside-dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "9router-out.log"), "OUTSIDE-VIA-JUNCTION\n", "utf8");

    const insideFile = path.join(logsDir, "9router-out.log");
    fs.writeFileSync(insideFile, "INSIDE-OK\n", "utf8");
    expect(resolveLogFileWithinRoot(insideFile, logsDir)).toBe(fs.realpathSync(insideFile));

    const junctionPath = path.join(logsDir, "leak");
    if (!tryDirLink(outsideDir, junctionPath)) {
      expect(resolveLogFileWithinRoot(insideFile, logsDir)).toBe(fs.realpathSync(insideFile));
      return;
    }
    expect(resolveLogFileWithinRoot(path.join(junctionPath, "9router-out.log"), logsDir)).toBeNull();
    expect(resolveLogFileWithinRoot(outsideDir, logsDir)).toBeNull();
  });

  it("allows the logs root itself to be a link when it resolves to a real directory", () => {
    const realDir = path.join(root, "real-logs");
    fs.mkdirSync(realDir, { recursive: true });
    const file = path.join(realDir, "9router-out.log");
    fs.writeFileSync(file, "root-link-ok\n", "utf8");

    const linkedRoot = path.join(root, "linked-root");
    if (!tryDirLink(realDir, linkedRoot)) {
      expect(resolveLogFileWithinRoot(file, realDir)).toBe(fs.realpathSync(file));
      return;
    }
    const resolved = resolveLogFileWithinRoot(path.join(linkedRoot, "9router-out.log"), linkedRoot);
    expect(resolved).toBe(fs.realpathSync(file));
  });
});

describe("getDockerLogs path confinement", () => {
  it("tolerates a symlinked .log that escapes <DATA_DIR>/logs", () => {
    const dataDir = path.join(root, "data");
    const logsDir = path.join(dataDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const secretFile = path.join(root, "docker-secret.txt");
    fs.writeFileSync(secretFile, "DOCKER-OUTSIDE-SECRET\n", "utf8");

    const linkPath = path.join(logsDir, "app.log");
    if (!tryFileSymlink(secretFile, linkPath)) {
      expect(resolveLogFileWithinRoot(secretFile, logsDir)).toBeNull();
      return;
    }

    process.env.DATA_DIR = dataDir;
    const result = getDockerLogs(50);
    expect(JSON.stringify(result)).not.toContain("DOCKER-OUTSIDE-SECRET");
  });
});

describe("GET /api/translator/console-logs redaction (real fetcher, mocked buffer)", () => {
  it("returns redacted supervisor lines and keeps the buffer untouched", async () => {
    const logsDir = path.join(root, "route-pm2", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "9router-error.log"),
      "boom Authorization: Bearer FAKE-BEARER-TOKEN-0123456789\n",
      "utf8",
    );
    process.env.PM2_HOME = path.join(root, "route-pm2");
    process.env.DATA_DIR = path.join(root, "no-docker-data");
    mocks.getConsoleLogs.mockReturnValue(["buffer line"]);

    const { GET } = await import("@/app/api/translator/console-logs/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    const text = JSON.stringify(body);
    assertNoSecrets(text);
    expect(text).toContain("boom");
    expect(body.logs).toEqual(["buffer line"]);
    expect(body.pm2Logs.join("\n")).toContain("[REDACTED]");
  });
});
