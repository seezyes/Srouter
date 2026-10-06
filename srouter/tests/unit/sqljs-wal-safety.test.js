import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";

let directory;
let adapter;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "srouter-sqljs-safety-")); });
afterEach(() => {
  adapter?.close();
  adapter = null;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("sql.js existing database safety", () => {
  it("rejects nonempty WAL without changing or deleting existing files", async () => {
    const file = path.join(directory, "data.sqlite");
    const main = Buffer.from("test-existing-main");
    const wal = Buffer.from("test-pending-wal");
    fs.writeFileSync(file, main);
    fs.writeFileSync(`${file}-wal`, wal);
    await expect(createSqlJsAdapter(file)).rejects.toThrow("requires a native driver");
    expect(fs.readFileSync(file)).toEqual(main);
    expect(fs.readFileSync(`${file}-wal`)).toEqual(wal);
  });

  it("can reopen a clean existing sql.js database without a WAL", async () => {
    const file = path.join(directory, "data.sqlite");
    adapter = await createSqlJsAdapter(file);
    adapter.exec("CREATE TABLE sample (value TEXT)");
    adapter.run("INSERT INTO sample VALUES (?)", ["preserved"]);
    adapter.close();
    adapter = await createSqlJsAdapter(file);
    expect(adapter.all("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }]);
    expect(adapter.get("SELECT value FROM sample")).toEqual({ value: "preserved" });
  });
});
