// Import accounts from a sibling 9router installation.
//
// POST /api/import/9router
//   { "mode": "preview" | "execute",
//     "options": { "connections": true, "apiKeys": false, "combos": false, "settings": false },
//     "selection": { "connections": ["connection:<sourceId>", ...] } }
//
// `selection` is optional. When it is present, only the listed connection
// keys are imported (and only they are planned into the preview); when it is
// absent the whole connections group is imported — the pre-selection
// behaviour, kept so existing callers keep working. A malformed selection is
// rejected with 400 instead of falling back to "import everything".
//
// `mode: "preview"` (the default) is a dry run: it reports whether the source
// database exists, its resolved path, table/row counts and what WOULD be
// imported. Secrets are masked in every response.
//
// Auth: /api/* is deny-by-default in src/dashboardGuard.js, so this route is
// already behind the dashboard session (or CLI token) guard. Because it reads
// files outside DATA_DIR it additionally requires a loopback/trusted-peer
// request, the same pattern as /api/provider-nodes/validate.

import { NextResponse } from "next/server";
import { isLocalRequest } from "@/dashboardGuard";
import { readSourceSnapshot, resolveSourcePaths, publicSource } from "@/lib/import/nineRouterSource.js";
import { buildPlan, publicPlan, normalizeImportOptions, normalizeImportSelection, runImport, collectLocalState } from "@/lib/import/importPlan.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOCAL_ONLY_ERROR = "Import runs on the machine hosting Srouter (local access only)";

// GET /api/import/9router — cheap source detection (no database read).
export async function GET(request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: LOCAL_ONLY_ERROR }, { status: 403 });
  }
  const paths = resolveSourcePaths();
  const hasSource = paths.dbFileExists || paths.legacyJsonFileExists;
  const snapshot = {
    paths,
    found: hasSource,
    kind: paths.dbFileExists ? "sqlite" : paths.legacyJsonFileExists ? "legacy-json" : null,
    driver: null,
    error: hasSource ? null : `No 9router database found at ${paths.dbFile}`,
    warnings: [],
    tables: [],
  };
  return NextResponse.json({
    ok: true,
    mode: "status",
    source: publicSource(snapshot),
    options: normalizeImportOptions(),
  });
}

// POST /api/import/9router — dry run (preview) or real import (execute).
export async function POST(request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ ok: false, error: LOCAL_ONLY_ERROR }, { status: 403 });
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
      { ok: false, mode, options, error: "Invalid selection: expected { connections: string[] }" },
      { status: 400 },
    );
  }

  try {
    const snapshot = await readSourceSnapshot();
    const source = publicSource(snapshot);

    if (!snapshot.found) {
      return NextResponse.json({
        ok: false,
        mode,
        source,
        options,
        error: snapshot.error || "9router data source not found",
      });
    }

    if (mode === "preview") {
      const localState = await collectLocalState();
      const plan = buildPlan({ snapshot, localState, options, selection });
      return NextResponse.json({ ok: true, mode, source, options, preview: publicPlan(plan) });
    }

    const { results, counts } = await runImport({ snapshot, options, selection });
    return NextResponse.json({ ok: true, mode, source, options, results, counts });
  } catch (error) {
    console.log("Error importing from 9router:", error);
    return NextResponse.json({ ok: false, mode, options, error: "Import failed" }, { status: 500 });
  }
}
