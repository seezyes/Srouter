import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { DEFAULT_ERROR_MESSAGES, GATEWAY_ERROR_CLASSES, GATEWAY_ERROR_LOG_MAX_BYTES } from "../config/errorConfig.js";

export function classifyError(error) {
  if (!error) return "UNKNOWN";
  if (error.isPolicyError) return "POLICY";
  const message = String(error.message || "").toLowerCase();
  if (message.includes("tool-call failure") || message.includes("tool call")) return "TOOL_CALL";
  if (message.includes("timeout") || message.includes("timed out") || error.name === "TimeoutError") return "TIMEOUT";
  if (message.includes("json") || message.includes("parse")) return "PARSE";
  if (message.includes("401") || message.includes("403") || message.includes("unauthorized") || message.includes("forbidden")) return "AUTH";
  if (message.includes("refresh") || message.includes("token")) return "TOKEN";
  if (/\bstream(?:ing)?\b|\brepetition\b/.test(message)) return "STREAM";
  if (error.statusCode >= 400 || error.status >= 400) return "PROVIDER";
  return "UNKNOWN";
}

// Metadata-only diagnostics. Provider bodies/messages/extra may echo credentials
// or private prompts, so they are classified but never emitted by this logger.
export function logGatewayError({ class: errorClass = "UNKNOWN", provider, model, status, connectionId } = {}) {
  const identifier = (value) => typeof value === "string" ? value.replace(/[\r\n\t]/g, "").slice(0, 200) : undefined;
  const entry = {
    ts: new Date().toISOString(),
    class: GATEWAY_ERROR_CLASSES.has(errorClass) ? errorClass : "UNKNOWN",
    provider: identifier(provider),
    model: identifier(model),
    status: Number.isInteger(status) ? status : undefined,
    connectionId: identifier(connectionId),
    message: errorClass === "POLICY" ? "Provider rejected request policy" : DEFAULT_ERROR_MESSAGES[status] || "Gateway error",
  };
  try { console.error(`[GATEWAY-ERROR] ${JSON.stringify(entry)}`); } catch {}
  try {
    const directory = path.join(DATA_DIR, "logs");
    const file = path.join(directory, "gateway-errors.jsonl");
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > GATEWAY_ERROR_LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A diagnostic failure must not change the provider response.
  }
}
