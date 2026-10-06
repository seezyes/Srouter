import { NextResponse } from "next/server";
import { createProviderConnectionsBulk, getProviderNodeById } from "@/models";
import {
  AI_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";

export async function POST(request) {
  try {
    const body = await request.json();
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 500) {
      return NextResponse.json({ error: "items must contain 1-500 connections" }, { status: 400 });
    }
    const items = body.items.map((item) => {
      const provider = normalizeProviderId(item.provider);
      // Web-cookie providers store the cookie as the credential; single-create
      // (POST /api/providers) labels those connections authType "cookie", so the
      // batch path must not mislabel them as API-key connections.
      return {
        provider,
        authType: WEB_COOKIE_PROVIDERS[provider] ? "cookie" : "apikey",
        apiKey: typeof item.apiKey === "string" ? item.apiKey.trim() : "",
        name: typeof item.name === "string" ? item.name.trim() : "",
        priority: Number.isInteger(item.priority) ? item.priority : 1,
        testStatus: "unknown",
        providerSpecificData: normalizeProviderSpecificData(provider, item, item.providerSpecificData),
      };
    });
    // Same acceptance set as POST /api/providers: API-key providers, free-tier
    // API-key providers, web-cookie providers, compatible LLM/embedding nodes and
    // dual-auth (OAuth + API key) providers. AI_PROVIDERS membership is NOT
    // required — compatible nodes are dynamic IDs that never appear there.
    const validProvider = (provider) => APIKEY_PROVIDERS[provider]
      || FREE_TIER_PROVIDERS[provider]
      || WEB_COOKIE_PROVIDERS[provider]
      || isOpenAICompatibleProvider(provider)
      || isAnthropicCompatibleProvider(provider)
      || isCustomEmbeddingProvider(provider)
      || AI_PROVIDERS[provider]?.authModes?.includes("apikey");
    if (items.some((item) => !validProvider(item.provider) || !item.apiKey || !item.name)) {
      return NextResponse.json({ error: "Every item requires a valid API-key provider, name, and apiKey" }, { status: 400 });
    }
    for (const item of items) {
      if (!isOpenAICompatibleProvider(item.provider) && !isAnthropicCompatibleProvider(item.provider) && !isCustomEmbeddingProvider(item.provider)) continue;
      const node = await getProviderNodeById(item.provider);
      if (!node?.baseUrl || !node.prefix) {
        return NextResponse.json({ error: "Compatible provider node missing or invalid" }, { status: 400 });
      }
      let url;
      try { url = new URL(node.baseUrl); } catch { /* invalid node URL */ }
      if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        return NextResponse.json({ error: "Invalid compatible provider base URL" }, { status: 400 });
      }
      item.providerSpecificData = {
        ...item.providerSpecificData,
        prefix: node.prefix, baseUrl: node.baseUrl, nodeName: node.name,
        ...(isOpenAICompatibleProvider(item.provider) ? { apiType: node.apiType } : {}),
      };
    }
    const names = new Set();
    for (const item of items) {
      const key = `${item.provider}:${item.name}`;
      if (names.has(key)) {
        return NextResponse.json({ error: "Duplicate provider/name in batch" }, { status: 409 });
      }
      names.add(key);
    }
    const results = await createProviderConnectionsBulk(items);
    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to create provider connections" }, { status: 500 });
  }
}
