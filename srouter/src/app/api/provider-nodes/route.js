import { NextResponse } from "next/server";
import { createProviderNode, getProviderNodes } from "@/models";
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX, CUSTOM_WEBSEARCH_PREFIX } from "@/shared/constants/providers";
import { validateLinkedSearchSource } from "@/lib/hostedSearch/validate.js";
import { generateId } from "@/shared/utils";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

// GET /api/provider-nodes - List all provider nodes
export async function GET() {
  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, type } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Determine type
    const nodeType = type || "openai-compatible";

    // Custom web search nodes address requests by their stable node id (bare
    // provider ids in webSearch combos), so a prefix alias is not required.
    if (nodeType !== "custom-websearch" && !prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses"].includes(apiType)) {
        return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim(),
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-embedding") {
      // Strip trailing slash and /embeddings if user pasted full endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_EMBEDDING_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }

      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-websearch") {
      const mode = body.mode;
      if (!["searxng", "json", "linked", "plugin"].includes(mode)) {
        return NextResponse.json({ error: "Invalid custom web search mode" }, { status: 400 });
      }

      let authHeader = "none";
      if (!["linked", "plugin"].includes(mode)) {
        authHeader = body.authHeader || (mode === "searxng" ? "none" : "bearer");
        if (!["none", "bearer", "x-api-key"].includes(authHeader)) {
          return NextResponse.json({ error: "Invalid auth header mode" }, { status: 400 });
        }
      }

      let baseUrl = null;
      let sourceProviderId = null;
      let sourceConnectionId = null;
      let sourceAdapterId = null;
      let sourceModel = null;

      if (["linked", "plugin"].includes(mode)) {
        const linked = await validateLinkedSearchSource(body);
        if (linked.error) return NextResponse.json({ error: linked.error }, { status: linked.status || 400 });
        ({ sourceProviderId, sourceConnectionId, sourceAdapterId, sourceModel } = linked);
      } else {
        baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
        if (!baseUrl) {
          return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
        }
        try {
          const parsed = new URL(baseUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("protocol");
          }
        } catch {
          return NextResponse.json({ error: "Invalid Base URL" }, { status: 400 });
        }
      }

      const node = await createProviderNode({
        id: `${CUSTOM_WEBSEARCH_PREFIX}${generateId()}`,
        type: "custom-websearch",
        name: name.trim(),
        mode,
        baseUrl,
        authHeader,
        sourceProviderId,
        sourceConnectionId,
        sourceAdapterId,
        sourceModel,
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      // Sanitize Base URL: remove trailing slash, and remove trailing /messages if user added it
      // This prevents double-appending /messages at runtime
      let sanitizedBaseUrl = (baseUrl || ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }

      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
