// Pass9 API configuration closure — translator console/system log merger.
//
// Route: src/app/api/translator/console-logs/route.js
// Contract: the console buffer and the PM2/Docker supervisor logs are BOTH
// surfaced (neither source silently dropped), with availability metadata.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConsoleLogs: vi.fn(),
  clearConsoleLogs: vi.fn(),
  initConsoleLogCapture: vi.fn(),
  getPm2Logs: vi.fn(),
  getDockerLogs: vi.fn(),
}));

vi.mock("@/lib/consoleLogBuffer", () => ({
  getConsoleLogs: mocks.getConsoleLogs,
  clearConsoleLogs: mocks.clearConsoleLogs,
  initConsoleLogCapture: mocks.initConsoleLogCapture,
}));
vi.mock("@/lib/systemLogFetcher", () => ({
  getPm2Logs: mocks.getPm2Logs,
  getDockerLogs: mocks.getDockerLogs,
}));

const { GET, DELETE } = await import("@/app/api/translator/console-logs/route.js");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getConsoleLogs.mockReturnValue(["buffer line"]);
  mocks.getPm2Logs.mockReturnValue({
    available: true,
    errorLogFile: "/tmp/pm2/9router-error.log",
    outLogFile: "/tmp/pm2/9router-out.log",
    errorLogs: ["[PM2-ERROR] boom"],
    outLogs: ["[PM2-OUT] ready"],
    combined: ["[PM2-ERROR] boom", "[PM2-OUT] ready"],
  });
  mocks.getDockerLogs.mockReturnValue({
    isDocker: true,
    available: true,
    logs: ["[DOCKER:app] started"],
  });
});

describe("GET /api/translator/console-logs", () => {
  it("returns the in-process buffer and the supervisor sources together", async () => {
    const body = await (await GET()).json();
    expect(body.success).toBe(true);
    expect(body.logs).toEqual(["buffer line"]);
    expect(body.pm2Logs).toEqual(["[PM2-ERROR] boom", "[PM2-OUT] ready"]);
    expect(body.dockerLogs).toEqual(["[DOCKER:app] started"]);
    expect(body.pm2Info).toEqual({
      available: true,
      errorLogFile: "/tmp/pm2/9router-error.log",
      outLogFile: "/tmp/pm2/9router-out.log",
      errorCount: 1,
    });
    expect(body.dockerInfo).toEqual({ isDocker: true, available: true });
    expect(mocks.getPm2Logs).toHaveBeenCalledWith(250);
    expect(mocks.getDockerLogs).toHaveBeenCalledWith(250);
  });

  it("keeps the console buffer when PM2 is unavailable", async () => {
    mocks.getPm2Logs.mockReturnValue({ available: false, combined: [], errorLogs: [], outLogs: [] });
    mocks.getDockerLogs.mockReturnValue({ isDocker: false, available: false, logs: [] });
    const body = await (await GET()).json();
    expect(body.logs).toEqual(["buffer line"]);
    expect(body.pm2Logs).toEqual([]);
    expect(body.pm2Info.available).toBe(false);
    expect(body.dockerInfo.available).toBe(false);
  });

  it("500s when a log source throws", async () => {
    mocks.getConsoleLogs.mockImplementation(() => { throw new Error("buffer failure"); });
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    // The pre-existing route surfaces error.message; this test pins the
    // status/shape contract, not the message text.
    expect(typeof body.error).toBe("string");
  });
});

describe("DELETE /api/translator/console-logs", () => {
  it("clears the buffer", async () => {
    const body = await (await DELETE()).json();
    expect(body).toEqual({ success: true });
    expect(mocks.clearConsoleLogs).toHaveBeenCalledTimes(1);
  });
});
