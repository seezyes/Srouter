import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Account-pool move wiring, pinned at the source level.
 *
 * `ConnectionRow` calls `onMoveToPool(poolId)` — one argument, no id. A page that
 * passes `handleMoveConnectionToPool` straight in therefore receives the POOL id
 * as `connectionId`, and the move PUTs `/api/providers/<pool-id>` with
 * `accountPoolId: null`, which 404s. The badge never changed and the failure was
 * invisible, so the row must get a closure bound to its own connection id.
 *
 * The suite has no DOM environment, so this pins the two ends of that contract
 * instead of rendering the table.
 */
const read = (relative) => fs.readFileSync(new URL(`../../src/${relative}`, import.meta.url), "utf8");

const ROW_CALL = 'onMoveToPool(poolId === "__none__" ? null : poolId)';
const CURRIED = 'onMoveToPool={poolsEnabled ? (poolId) => handleMoveConnectionToPool(conn.id, poolId) : null}';
const BARE = 'onMoveToPool={poolsEnabled ? handleMoveConnectionToPool : null}';

describe("account pool move wiring", () => {
  it("calls the handler with the pool id only, from the row", () => {
    expect(read("app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js")).toContain(ROW_CALL);
    expect(read("app/(dashboard)/dashboard/providers/components/ConnectionsCard.js")).toContain(ROW_CALL);
  });

  it("binds every row's own connection id before passing the handler down", () => {
    expect(read("app/(dashboard)/dashboard/providers/[id]/page.js")).toContain(CURRIED);
    expect(read("app/(dashboard)/dashboard/providers/components/ConnectionsCard.js")).toContain(CURRIED);
  });

  it("never passes the unbound handler into a row", () => {
    expect(read("app/(dashboard)/dashboard/providers/[id]/page.js")).not.toContain(BARE);
    expect(read("app/(dashboard)/dashboard/providers/components/ConnectionsCard.js")).not.toContain(BARE);
  });
});
