import { handleChat } from "@/sse/handlers/chat.js";
import { readBoundedText } from "@/sse/utils/boundedBody.js";
import { initTranslators } from "open-sse/translator/index.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";

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

export async function POST(request) {
  await ensureInitialized();
  
  const { raw, error } = await readBoundedText(request);
  if (error) return error;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  const modelName = body.model || "llama3.2";
  const boundedRequest = new Request(request.url, {
    method: "POST", headers: request.headers, body: raw, signal: request.signal
  });
  const response = await handleChat(boundedRequest);
  return transformToOllama(response, modelName);
}

