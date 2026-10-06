import { NextResponse } from "next/server";
import { deleteProviderConnectionsByProvider, deleteProviderNode, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "@/models";
import { validateLinkedSearchSource } from "@/lib/hostedSearch/validate.js";

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, prefix, apiType, baseUrl } = body;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Custom web search nodes have no prefix alias and their fields depend on
    // the mode; connection propagation (prefix/baseUrl in providerSpecificData)
    // is an embedding/LLM-node concern and does not apply here: search dispatch
    // always reads the node itself.
    if (node.type === "custom-websearch") {
      const mode = body.mode || node.mode;
      if (!["searxng", "json", "linked", "plugin"].includes(mode)) {
        return NextResponse.json({ error: "Invalid custom web search mode" }, { status: 400 });
      }
      const authHeader = ["linked", "plugin"].includes(mode) ? "none" : (body.authHeader || node.authHeader || (mode === "searxng" ? "none" : "bearer"));
      if (!["none", "bearer", "x-api-key"].includes(authHeader)) {
        return NextResponse.json({ error: "Invalid auth header mode" }, { status: 400 });
      }
      let nextBaseUrl = node.baseUrl;
      let sourceProviderId = node.sourceProviderId;
      let sourceConnectionId = body.sourceConnectionId !== undefined ? (body.sourceConnectionId ? String(body.sourceConnectionId).trim() : null) : node.sourceConnectionId;
      let sourceAdapterId = body.sourceAdapterId !== undefined ? body.sourceAdapterId : node.sourceAdapterId;
      let sourceModel = body.sourceModel !== undefined ? body.sourceModel : node.sourceModel;
      if (["linked", "plugin"].includes(mode)) {
        nextBaseUrl = null;
        if (body.sourceProviderId !== undefined) sourceProviderId = String(body.sourceProviderId || "").trim();
        const linked = await validateLinkedSearchSource({ mode, sourceProviderId, sourceConnectionId, sourceAdapterId,
          sourceModel: mode === "plugin" ? body.sourceModel : sourceModel });
        if (linked.error) return NextResponse.json({ error: linked.error }, { status: linked.status || 400 });
        ({ sourceProviderId, sourceConnectionId, sourceAdapterId, sourceModel } = linked);
      } else {
        sourceProviderId = null;
        sourceConnectionId = null;
        sourceAdapterId = null;
        sourceModel = null;
        if (body.baseUrl !== undefined) {
          nextBaseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
          if (!nextBaseUrl) {
            return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
          }
          try {
            const parsed = new URL(nextBaseUrl);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
          } catch {
            return NextResponse.json({ error: "Invalid Base URL" }, { status: 400 });
          }
        } else if (!nextBaseUrl) {
          return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
        }
      }
      const updated = await updateProviderNode(id, {
        name: name.trim(),
        mode,
        baseUrl: nextBaseUrl,
        authHeader,
        sourceProviderId,
        sourceConnectionId,
        sourceAdapterId,
        sourceModel,
      });
      return NextResponse.json({ node: updated });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Only validate apiType for OpenAI Compatible nodes
    if (node.type === "openai-compatible" && (!apiType || !["chat", "responses"].includes(apiType))) {
      return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
    }

    if (!baseUrl?.trim()) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }

    let sanitizedBaseUrl = baseUrl.trim();
    
    // Sanitize Base URL for Anthropic Compatible
    if (node.type === "anthropic-compatible") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }
    }

    // Sanitize Base URL for Custom Embedding (strip trailing slash and /embeddings)
    if (node.type === "custom-embedding") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }
    }

    const updates = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
    };

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
    }

    const updated = await updateProviderNode(id, updates);

    const connections = await getProviderConnections({ provider: id });
    await Promise.all(connections.map((connection) => (
      updateProviderConnection(connection.id, {
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          prefix: prefix.trim(),
          apiType: node.type === "openai-compatible" ? apiType : undefined,
          baseUrl: sanitizedBaseUrl,
          nodeName: updated.name,
        }
      })
    )));

    return NextResponse.json({ node: updated });
  } catch (error) {
    console.log("Error updating provider node:", error);
    return NextResponse.json({ error: "Failed to update provider node" }, { status: 500 });
  }
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    await deleteProviderConnectionsByProvider(id);
    await deleteProviderNode(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return NextResponse.json({ error: "Failed to delete provider node" }, { status: 500 });
  }
}
