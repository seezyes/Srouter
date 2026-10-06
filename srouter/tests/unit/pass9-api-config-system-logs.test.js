// Pass9 API configuration closure — system log fetcher (real filesystem read).
//
// Exercises src/lib/systemLogFetcher.js against a private temporary directory:
// PM2 tailing, Docker/data-dir tailing, ANSI stripping and the fail-safe empty
// result when no log source exists. No working instance directory is read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getPm2Logs, getDockerLogs, readTailLines } from "../../src/lib/systemLogFetcher.js";

let root;
let prevPm2Home;
let prevDataDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pass9-api-config-logs-"));
  prevPm2Home = process.env.PM2_HOME;
  prevDataDir = process.env.DATA_DIR;
});

afterEach(() => {
  if (prevPm2Home === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = prevPm2Home;
  if (prevDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevDataDir;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("readTailLines", () => {
  it("returns the last N non-empty lines with ANSI stripped", () => {
    const file = path.join(root, "sample.log");
    fs.writeFileSync(file, ["\u001b[31mone\u001b[0m", "", "two", "three", "four"].join("\n"));
    expect(readTailLines(file, 1024, 2)).toEqual(["three", "four"]);
  });

  it("returns [] for a missing file and never throws", () => {
    expect(readTailLines(path.join(root, "nope.log"))).toEqual([]);
  });
});

describe("getPm2Logs", () => {
  it("reads router error and out logs and labels untagged lines", () => {
    const logsDir = path.join(root, "pm2logs", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "9router-error.log"), "first crash\n[ERROR] tagged\n");
    fs.writeFileSync(path.join(logsDir, "9router-out.log"), "listening on 20129\n");

    process.env.PM2_HOME = path.join(root, "pm2logs");
    const result = getPm2Logs(50);

    expect(result.available).toBe(true);
    expect(result.errorLogFile).toContain("9router-error.log");
    expect(result.outLogFile).toContain("9router-out.log");
    expect(result.errorLogs).toContain("[PM2-ERROR] first crash");
    expect(result.errorLogs).toContain("[ERROR] tagged");
    expect(result.outLogs).toEqual(["[PM2-OUT] listening on 20129"]);
    expect(result.combined.length).toBe(3);
  });

  it("reports unavailable without a PM2 log directory", () => {
    process.env.PM2_HOME = path.join(root, "missing-pm2");
    const result = getPm2Logs(50);
    expect(result.available).toBe(false);
    expect(result.combined).toEqual([]);
    expect(result.reason).toContain("not found");
  });

  it("does not misclassify the error log as stdout (router contains 'out')", () => {
    const logsDir = path.join(root, "only-error", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "9router-error.log"), "crash\n");

    process.env.PM2_HOME = path.join(root, "only-error");
    const result = getPm2Logs(50);

    expect(result.errorLogFile).toContain("9router-error.log");
    expect(result.outLogFile).toBeNull();
    expect(result.available).toBe(true);
  });

  it("matches numbered stdout logs (9router-out-0.log)", () => {
    const logsDir = path.join(root, "numbered", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "9router-out-0.log"), "boot\n");

    process.env.PM2_HOME = path.join(root, "numbered");
    const result = getPm2Logs(50);

    expect(result.outLogFile).toContain("9router-out-0.log");
    expect(result.outLogs).toEqual(["[PM2-OUT] boot"]);
  });

  it("reads only under PM2_HOME/logs, not PM2_HOME itself", () => {
    const pm2Home = path.join(root, "boundary");
    fs.mkdirSync(pm2Home, { recursive: true });
    // A log file sitting directly in PM2_HOME must NOT be treated as a PM2 log.
    fs.writeFileSync(path.join(pm2Home, "9router-error.log"), "outside the logs dir\n");

    process.env.PM2_HOME = pm2Home;
    const result = getPm2Logs(50);

    expect(result.available).toBe(false);
    expect(result.errorLogs).toEqual([]);
  });
});

describe("getDockerLogs", () => {
  it("tails <DATA_DIR>/logs when the directory exists", () => {
    const logsDir = path.join(root, "data", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "app.log"), "container line\n");

    process.env.DATA_DIR = path.join(root, "data");
    const result = getDockerLogs(50);

    expect(result.available).toBe(true);
    expect(result.logs).toEqual(["[DOCKER:app] container line"]);
  });

  it("reports unavailable when no container/data log directory exists", () => {
    process.env.DATA_DIR = path.join(root, "empty");
    const result = getDockerLogs(50);
    expect(result.available).toBe(false);
    expect(result.logs).toEqual([]);
  });

  it("reads only <DATA_DIR>/logs, not .log files directly in DATA_DIR", () => {
    const dataDir = path.join(root, "boundary-data");
    fs.mkdirSync(dataDir, { recursive: true });
    // A .log directly in DATA_DIR must NOT be picked up (boundary safety).
    fs.writeFileSync(path.join(dataDir, "secret.env.log"), "TOKEN=very-secret\n");

    process.env.DATA_DIR = dataDir;
    const result = getDockerLogs(50);

    expect(result.available).toBe(false);
    expect(result.logs).toEqual([]);
  });
});
