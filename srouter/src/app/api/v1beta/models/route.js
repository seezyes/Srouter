import { PROVIDER_MODELS, getModelKind } from "@/shared/constants/models";
import { authenticateRequest } from "@/sse/services/requestAccess.js";
import { isKindAllowed, isProviderAllowed } from "@/sse/services/access.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET(request) {
  try {
    const { apiKeyInfo, error: authError } = await authenticateRequest(request);
    if (authError) return authError;
    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent"] }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: 128000,
        outputTokenLimit: 8192,
      });
    }
    
    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const accessProvider = provider === "gemini-tts-models" ? "gemini" : provider;
      if (!await isProviderAllowed(apiKeyInfo, accessProvider)) continue;
      for (const model of providerModels) {
        const kind = provider === "gemini-tts-models" ? "tts" : getModelKind(model, "llm");
        if (!isKindAllowed(apiKeyInfo, kind)) continue;
        addModel({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
        });

        if (provider === "gemini") {
          addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Gemini model: ${model.name || model.id}`,
            methods: ["generateContent", "streamGenerateContent"],
          });
        }
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
