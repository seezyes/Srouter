import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db";
import { PROVIDERS } from "open-sse/config/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { normalizeProviderOverride, isBlockedOverrideHeader } from "open-sse/utils/providerOverrides.js";
import { readBoundedJson } from "@/sse/utils/boundedBody.js";

export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "no-store" } };
// Serialize this route's read/modify/write operations so two provider saves do
// not erase each other's overrides within the server process.
let saveQueue = Promise.resolve();

export async function GET(_request, { params }) {
  const { id } = await params;
  const canonical = resolveProviderAlias(id);
  if (!Object.hasOwn(PROVIDERS, canonical)) return NextResponse.json({ error: "Unknown provider" }, { status: 404, ...noStore });
  try {
    const settings = await getSettings();
    let override = null;
    try { override = normalizeProviderOverride(settings.providerOverrides?.[canonical] || {}); } catch { /* malformed imported settings */ }
    const builtinHeaders = Object.fromEntries(Object.entries(PROVIDERS[canonical]?.headers || {})
      .filter(([name]) => !isBlockedOverrideHeader(name)));
    return NextResponse.json({ headers: override?.headers || {}, builtinHeaders }, noStore);
  } catch {
    return NextResponse.json({ error: "Failed to get overrides" }, { status: 500, ...noStore });
  }
}

export async function PUT(request, { params }) {
  const { id } = await params;
  const canonical = resolveProviderAlias(id);
  if (!Object.hasOwn(PROVIDERS, canonical)) return NextResponse.json({ error: "Unknown provider" }, { status: 404, ...noStore });
  const { body, error } = await readBoundedJson(request);
  if (error) return error;
  let override;
  try { override = normalizeProviderOverride(body); } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400, ...noStore });
  }
  const save = saveQueue.catch(() => {}).then(async () => {
    const settings = await getSettings();
    const next = { ...(settings.providerOverrides || {}) };
    if (override) next[canonical] = override;
    else delete next[canonical];
    await updateSettings({ providerOverrides: next });
  });
  saveQueue = save;
  try {
    await save;
    return NextResponse.json({ headers: override?.headers || {} }, noStore);
  } catch {
    return NextResponse.json({ error: "Failed to save overrides" }, { status: 500, ...noStore });
  }
}
