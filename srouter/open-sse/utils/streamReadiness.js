import { STREAM_READINESS_TIMEOUT_MS } from "../config/runtimeConfig.js";

// Peek once before committing HTTP 200. A slow first read is retained and
// replayed, not cancelled/replaced by a second concurrent reader.read().
export async function prepareUpstreamStream(response, signal, timeoutMs = STREAM_READINESS_TIMEOUT_MS) {
  if (!response.body) return { earlyEof: true };
  const reader = response.body.getReader();
  let timer;
  let abortListener;
  const pending = reader.read();
  let first;
  try {
    first = await Promise.race([
      pending,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      new Promise((_, reject) => {
        abortListener = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abortListener();
        else signal?.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } catch (error) {
    reader.cancel().catch(() => {});
    reader.releaseLock();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortListener);
  }
  if (first?.done) {
    reader.releaseLock();
    return { earlyEof: true };
  }
  let next = first ? Promise.resolve(first) : pending;
  let closed = false;
  const release = () => { if (!closed) { closed = true; reader.releaseLock(); } };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await (next || reader.read());
        next = null;
        if (result.done) { release(); controller.close(); }
        else controller.enqueue(result.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { release(); }
    },
  });
  return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }) };
}
