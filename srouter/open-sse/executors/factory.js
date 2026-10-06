import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  FACTORY_CLIENT_VERSION,
  FACTORY_MODEL_META,
  FACTORY_WIRE_URLS,
} from "../providers/registry/factory.js";

// Per-request identity carried on the credentials object (same pattern as
// xiaomi-mimo's account cookie): prepared in execute() and read back by the
// sync buildHeaders() hook.
const IDENTITY_FIELD = "__factoryIdentity";

// OpenAI platform org hint the Droid CLI attaches for openai-routed models.
const OPENAI_PLATFORM_ORG = "org-bHuLtG1fGmYk5YaOihAAXFBw";
// Node runtime the CLI's packaged binary reports in the Stainless fingerprint.
const STAINLESS_RUNTIME_VERSION = "v24.3.0";
const STAINLESS_PACKAGE_VERSION = { openai: "6.25.0", claude: "0.70.1" };
const OPENAI_UPSTREAMS = new Set(["openai", "azure_openai"]);

// Upstream calls may hand us either the bare id or a `provider/model` ref;
// thinking suffixes like "model(high)" are stripped for registry lookup.
export function bareFactoryModelId(model) {
  const raw = String(model ?? "").trim();
  const bare = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return bare.replace(/\([^()]+\)\s*$/, "").trim();
}

/** Wire protocol for a model, from the static registry snapshot. */
export function resolveFactoryWire(model) {
  const meta = FACTORY_MODEL_META[bareFactoryModelId(model)];
  return meta?.targetFormat || "openai";
}

/** First upstream of the model's rotation, sent as `x-api-provider`. */
export function resolveFactoryUpstream(model) {
  const meta = FACTORY_MODEL_META[bareFactoryModelId(model)];
  return meta?.upstream || "fireworks";
}

/** Deterministic v4-shaped UUID for the proxy's session attribution headers. */
export function factorySessionUuid(seed) {
  const digest = crypto.createHash("sha256").update(`factory\0${seed || ""}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * External org id (`X-Factory-Org-Id`) from a WorkOS JWT's claims, when the
 * credential is a JWT. Decoded without verification — the server verifies the
 * signature; this is only a routing hint. Never throws, never logs the token.
 */
export function factoryOrgIdFromToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const orgId = payload?.external_org_id;
    return typeof orgId === "string" && orgId.trim() ? orgId.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Identity headers the Factory proxy expects on every wire (verified against
 * the CLI's live traffic). The Responses route deliberately gets no Stainless
 * fingerprint: its WAF rejects the larger header budget.
 */
export function buildFactoryIdentityHeaders({ wire, upstream, identity, stream = true }) {
  const headers = {
    "User-Agent": `factory-cli/${FACTORY_CLIENT_VERSION}`,
    "X-Client-Version": FACTORY_CLIENT_VERSION,
    "X-Factory-Client": "cli",
    "x-api-provider": upstream,
    "x-provider-routing-source": "configured_order",
    "x-session-id": identity.sessionUuid,
    "x-assistant-message-id": identity.requestId,
  };
  if (identity.orgId) headers["X-Factory-Org-Id"] = identity.orgId;

  if (wire === "openai" || wire === "openai-responses") {
    headers.Accept = "application/json";
    if (OPENAI_UPSTREAMS.has(upstream)) headers["OpenAI-Platform"] = OPENAI_PLATFORM_ORG;
  }
  if (wire === "openai" || wire === "claude") {
    headers["X-Stainless-Lang"] = "js";
    headers["X-Stainless-Package-Version"] = STAINLESS_PACKAGE_VERSION[wire];
    headers["X-Stainless-Runtime"] = "node";
    headers["X-Stainless-Runtime-Version"] = STAINLESS_RUNTIME_VERSION;
    headers["X-Stainless-Arch"] = process.arch;
    headers["X-Stainless-OS"] = process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux";
    headers["X-Stainless-Retry-Count"] = "0";
  }
  if (wire === "claude") {
    headers["X-Stainless-Timeout"] = "600";
    if (!headers["x-api-key"]) headers["x-api-key"] = "placeholder";
    if (!headers["anthropic-version"]) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
  }
  return headers;
}

/** Structured upstream message only — raw bodies are never echoed to clients. */
function extractStructuredMessage(bodyText) {
  if (typeof bodyText !== "string" || !bodyText.trim()) return "";
  try {
    const parsed = JSON.parse(bodyText);
    const candidate = parsed?.error?.message
      || parsed?.message
      || (typeof parsed?.error === "string" ? parsed.error : "");
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 280);
  } catch {
    // non-JSON body: no structured message to surface
  }
  return "";
}

const INFERENCE_CREDENTIAL_HINT =
  "Factory rejected this credential for model inference. Factory API keys (fk-...) are control-plane only: "
  + "they validate and track quota here, but inference needs the WorkOS session token issued by the official Droid CLI login.";

export class FactoryExecutor extends DefaultExecutor {
  constructor() {
    super("factory");
  }

  prepareRequestCredentials({ body, credentials, providerSessionId } = {}) {
    const source = credentials || {};
    const seed = providerSessionId || resolveSessionId({
      headers: source.rawHeaders,
      body,
      connectionId: source.connectionId,
      scope: "factory",
    });
    return {
      ...source,
      [IDENTITY_FIELD]: {
        sessionUuid: factorySessionUuid(seed),
        requestId: crypto.randomUUID(),
        orgId: factoryOrgIdFromToken(source.apiKey || source.accessToken),
      },
    };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    return super.execute({ ...args, credentials });
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // A source-format-matched transport (set by chatCore) wins; otherwise pick
    // the endpoint from the model's declared wire so translated requests still
    // land on the right family (Claude models never hit an OpenAI endpoint).
    if (!credentials?.runtimeTransport?.baseUrl) {
      return FACTORY_WIRE_URLS[resolveFactoryWire(model)] || FACTORY_WIRE_URLS.openai;
    }
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials || {}, stream, url, model);
    const identity = credentials?.[IDENTITY_FIELD]
      || this.prepareRequestCredentials({ credentials })[IDENTITY_FIELD];
    Object.assign(headers, buildFactoryIdentityHeaders({
      wire: resolveFactoryWire(model),
      upstream: resolveFactoryUpstream(model),
      identity,
      stream,
    }));
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body, stream, credentials);
    // The CLI pins temperature=1 on the chat-completions wire; an explicit
    // caller temperature is left untouched.
    if (out && typeof out === "object" && resolveFactoryWire(model) === "openai" && out.temperature == null) {
      out.temperature = 1;
    }
    return out;
  }

  parseError(response, bodyText) {
    const status = response?.status ?? 0;
    if (status === 401 || status === 403) {
      const upstream = extractStructuredMessage(bodyText);
      return {
        status,
        message: upstream ? `${upstream} — ${INFERENCE_CREDENTIAL_HINT}` : INFERENCE_CREDENTIAL_HINT,
      };
    }
    return super.parseError(response, bodyText);
  }
}

export const __test__ = {
  IDENTITY_FIELD,
  extractStructuredMessage,
  buildFactoryIdentityHeaders,
};

export default FactoryExecutor;
