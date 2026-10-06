import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Called from vi.hoisted, before any application import. Never adopt or close
// an inherited adapter: it might point at working data, even after resetModules.
export function createIsolatedZedDb() {
  if (globalThis._dbAdapter) {
    throw new Error("Zed isolation requires a fresh worker without a cached DB adapter");
  }
  const inheritedDataDir = process.env.DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-zed-test-"));
  const state = { instance: null, initPromise: null, logged: false };
  process.env.DATA_DIR = dataDir;
  globalThis._dbAdapter = state;

  return {
    dataDir,
    inheritedDataDir,
    async cleanup() {
      if (globalThis._dbAdapter !== state) {
        throw new Error("Zed DB adapter ownership changed; refusing cleanup");
      }
      // sql.js close flushes pending writes and cancels its save timer; native
      // adapters close SQLite handles/checkpoint timers before directory removal.
      const adapter = state.instance || (state.initPromise && await state.initPromise);
      adapter?.close();
      delete globalThis._dbAdapter;
      if (inheritedDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = inheritedDataDir;
      // Only the exact directory returned by our own mkdtemp is removable.
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (fs.existsSync(dataDir)) throw new Error("Zed temporary DB cleanup failed");
    },
  };
}
