// Dev-only import: copy accounts, API keys, combos and settings from the main
// (non-dev) Srouter instance into this dev install. Shown on /dashboard/import
// only when Developer settings is on; the API itself is always gated by the
// dev launcher's env pair (see mainInstanceSource.js) — the Developer toggle
// only controls visibility of the section.
//
// POST /api/import/main
//   { "mode": "preview" | "execute",
//     "options": { "connections": true, "apiKeys": false, "combos": false, "settings": false },
//     "selection": { "connections": ["connection:<sourceId>", ...] } }
//
// Contract is intentionally identical to /api/import/9router: same options,
// same optional selection semantics (absent = whole group; malformed = 400),
// same read-only snapshot, same plan/execute engine. The source location comes
// from the launcher environment only — never from the client.
//
// Auth: /api/* is deny-by-default in src/dashboardGuard.js, so this route is
// behind the dashboard session (or CLI token) guard. Because it reads files
// outside DATA_DIR it additionally requires a loopback/trusted-peer request,
// the same pattern as /api/import/9router.

import { NextResponse } from "next/server";
import { isLocalRequest } from "@/dashboardGuard";
import {
  MAIN_IMPORT_APP_LABEL,
  mainImportSourcePaths,
  readMainImportSnapshot,
  resolveMainImportConfig,
} from "@/lib/import/mainInstanceSource.js";
import { publicSource } from "@/lib/import/nineRouterSource.js";
import { buildPlan, publicPlan, normalizeImportOptions, normalizeImportSelection, runImport, collectLocalState } from "@/lib/import/importPlan.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOCAL_ONLY_ERROR = "Import runs on the machine hosting Srouter (local access only)";
const INACTIVE_ERROR = "Dev import from the main instance is available only in the SrouterDev instance";

// GET /api/import/main — cheap status (no database read).
export async function GET(request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, active: false, error: LOCAL_ONLY_ERROR }, { status: 403 });
  }
  const config = resolveMainImportConfig();
  if (!config.active) {
    // Not the dev instance (or misconfigured): nothing to show, no paths revealed.
    return NextResponse.json({
      ok: true,
      active: false,
      reason: config.reason,
      options: normalizeImportOptions(),
    });
  }

  const paths = mainImportSourcePaths(config);
  const hasSource = paths.dbFileExists || paths.legacyJsonFileExists;
  const snapshot = {
    paths,
    found: hasSource,
    kind: paths.dbFileExists ? "sqlite" : paths.legacyJsonFileExists ? "legacy-json" : null,
    driver: null,
    error: hasSource ? null : `No ${MAIN_IMPORT_APP_LABEL} database found at ${paths.dbFile}`,
    warnings: [],
    tables: [],
  };
  return NextResponse.json({
    ok: true,
    active: true,
    mode: "status",
    source: publicSource(snapshot, MAIN_IMPORT_APP_LABEL),
    options: normalizeImportOptions(),
  });
}

// POST /api/import/main — dry run (preview) or real import (execute).
export async function POST(request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, active: false, error: LOCAL_ONLY_ERROR }, { status: 403 });
  }
  const config = resolveMainImportConfig();
  if (!config.active) {
    return NextResponse.json(
      { ok: false, active: false, reason: config.reason, error: INACTIVE_ERROR },
      { status: 403 },
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const mode = body?.mode === "execute" ? "execute" : "preview";
  const options = normalizeImportOptions(body?.options);
  const selection = normalizeImportSelection(body?.selection);
  if (selection === undefined) {
    return NextResponse.json(
      { ok: false, active: true, mode, options, error: "Invalid selection: expected { connections: string[] }" },
      { status: 400 },
    );
  }

  try {
    const snapshot = await readMainImportSnapshot(config);
    const source = publicSource(snapshot, MAIN_IMPORT_APP_LABEL);

    if (!snapshot.found) {
      return NextResponse.json({
        ok: false,
        active: true,
        mode,
        source,
        options,
        error: snapshot.error || "Main instance data source not found",
      });
    }

    if (mode === "preview") {
      const localState = await collectLocalState();
      const plan = buildPlan({ snapshot, localState, options, selection });
      return NextResponse.json({ ok: true, active: true, mode, source, options, preview: publicPlan(plan) });
    }

    const { results, counts } = await runImport({ snapshot, options, selection });
    return NextResponse.json({ ok: true, active: true, mode, source, options, results, counts });
  } catch (error) {
    console.log("Error importing from the main Srouter instance:", error);
    return NextResponse.json({ ok: false, active: true, mode, options, error: "Import failed" }, { status: 500 });
  }
}
