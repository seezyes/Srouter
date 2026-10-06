import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function maxBodyBytes(limit) {
  if (Number.isSafeInteger(limit) && limit > 0) return limit;
  const configured = process.env.SROUTER_MAX_BODY_BYTES;
  const parsed = configured && Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function tooLarge(bytes, max) {
  return errorResponse(
    HTTP_STATUS.PAYLOAD_TOO_LARGE,
    `Request body too large (${bytes} bytes, limit ${max}). Raise SROUTER_MAX_BODY_BYTES to accept it.`
  );
}

export async function readBoundedText(request, limit) {
  const max = maxBodyBytes(limit);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    return { error: tooLarge(declared, max) };
  }

  const reader = request.body?.getReader();
  const chunks = [];
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > max) {
          await reader.cancel().catch(() => {});
          return { error: tooLarge(bytes, max) };
        }
        chunks.push(value);
      }
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
    } finally {
      reader.releaseLock();
    }
  }

  return { raw: Buffer.concat(chunks).toString("utf8"), bytes };
}

export async function readBoundedJson(request, limit) {
  const { raw, bytes, error } = await readBoundedText(request, limit);
  if (error) return { error };
  try {
    return { body: JSON.parse(raw), bytes };
  } catch {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
  }
}
