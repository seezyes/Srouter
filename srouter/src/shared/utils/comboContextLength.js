const MAX_CONTEXT_LENGTH = 2_000_000;

export function validateContextLength(value) {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, error: "context_length must be a positive integer" };
  }
  if (n > MAX_CONTEXT_LENGTH) {
    return { ok: false, error: `context_length must not exceed ${MAX_CONTEXT_LENGTH}` };
  }
  return { ok: true, value: n };
}
