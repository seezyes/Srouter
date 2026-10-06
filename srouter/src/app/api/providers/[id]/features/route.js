import { NextResponse } from "next/server";
import { getSettings, updateProviderFeatures } from "@/lib/db/repos/settingsRepo.js";
import { getProviderNodeById } from "@/lib/db";
import { PROVIDERS } from "open-sse/config/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { getProviderFeatures, PROVIDER_FEATURE_KEYS } from "open-sse/config/providerFeatures.js";
import { readBoundedJson } from "@/sse/utils/boundedBody.js";

export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "no-store" } };

async function resolveProvider(params) {
  const { id } = await params;
  const canonical = resolveProviderAlias(id);
  if (Object.hasOwn(PROVIDERS, canonical)) return canonical;
  return await getProviderNodeById(canonical) ? canonical : null;
}

export async function GET(_request, { params }) {
  try {
    const provider = await resolveProvider(params);
    if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404, ...noStore });
    return NextResponse.json({
      features: getProviderFeatures(provider, await getSettings()),
      capabilities: { accountPools: true, serviceTier: provider === "codex", customHeaders: true },
    }, noStore);
  } catch {
    return NextResponse.json({ error: "Failed to load provider features" }, { status: 500, ...noStore });
  }
}

export async function PATCH(request, { params }) {
  try {
    const provider = await resolveProvider(params);
    if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404, ...noStore });
    const { body, error } = await readBoundedJson(request);
    if (error) return error;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !PROVIDER_FEATURE_KEYS.includes(Object.keys(body)[0]) ||
      typeof Object.values(body)[0] !== "boolean") {
      return NextResponse.json({ error: "Provide one boolean feature switch" }, { status: 400, ...noStore });
    }
    if (Object.hasOwn(body, "serviceTier") && provider !== "codex") {
      return NextResponse.json({ error: "Account service tier is not supported by this provider" }, { status: 400, ...noStore });
    }
    const settings = await updateProviderFeatures(provider, body);
    return NextResponse.json({ features: getProviderFeatures(provider, settings) }, noStore);
  } catch {
    return NextResponse.json({ error: "Failed to save provider features" }, { status: 500, ...noStore });
  }
}
