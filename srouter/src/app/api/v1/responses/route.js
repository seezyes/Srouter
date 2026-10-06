import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { readBoundedJson } from "@/sse/utils/boundedBody.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Now handled by translator pattern (openai-responses format auto-detected)
 */
export async function POST(request) {
  await ensureInitialized();
  const { body, error } = await readBoundedJson(request);
  if (error) return error;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Request body must be an object" }, { status: 400 });
  }
  if (body.stream === undefined) body.stream = false;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const normalized = new Request(request.url, {
    method: "POST", headers, body: JSON.stringify(body), signal: request.signal,
  });
  return await handleChat(normalized);
}
