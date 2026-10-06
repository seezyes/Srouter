import { fetchWithTimeout, U } from "./shared.js";

function nonNegativeNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function dailyQuota(limit, usedValue, remainingValue) {
  const used = nonNegativeNumber(usedValue);
  if (used === null) return null;
  if (limit === null) {
    return { used, total: 0, unlimited: true, remainingPercentage: 100, resetAt: null };
  }
  const total = nonNegativeNumber(limit);
  if (total === null) return null;
  const remaining = nonNegativeNumber(remainingValue) ?? Math.max(0, total - used);
  return {
    used,
    total,
    remaining,
    remainingPercentage: total > 0 ? Math.min(100, remaining / total * 100) : 0,
    unlimited: false,
    resetAt: null,
  };
}

export function normalizeBurnGateUsage(data) {
  const limits = data?.limits;
  const used = data?.used;
  if (!limits || !used) return { message: "BurnGate returned an unsupported usage response." };

  const quotas = {};
  const input = dailyQuota(limits.dailyInput, used.input);
  const output = dailyQuota(limits.dailyOutput, used.output, data.remaining?.user_output);
  if (input) quotas["User daily input tokens"] = input;
  if (output) quotas["User daily output tokens"] = output;
  if (!input || !output) return { message: "BurnGate returned an unsupported usage response." };

  // Pool capacity and reset timezone are not provided. Do not invent totals,
  // resets or treat RPM/concurrency limits as measured consumption.
  const effectiveOutput = nonNegativeNumber(data.remaining?.effective_output);
  if (effectiveOutput !== null) {
    quotas["Effective output tokens"] = {
      used: 0, total: 0, remainingTokens: effectiveOutput, resetAt: null,
    };
  }
  return {
    plan: "BurnGate",
    quotas,
    remaining: {
      poolOutput: nonNegativeNumber(data.remaining?.pool_output),
      effectiveOutput,
    },
  };
}

export async function getBurnGateUsage(apiKey, proxyOptions = null) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "BurnGate API key not available. Add a key to view usage." };
  }
  try {
    const response = await fetchWithTimeout(U("burngate").url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
    }, 10000, proxyOptions);
    if (response.status === 401 || response.status === 403) {
      return { message: "BurnGate authentication failed. Check the API key." };
    }
    if (response.status === 429) {
      return { message: "BurnGate usage rate limit reached. Try again later." };
    }
    if (!response.ok) {
      return { message: `BurnGate usage API error (${response.status}).` };
    }
    return normalizeBurnGateUsage(await response.json());
  } catch {
    // Never forward provider bodies, identity or network errors containing secrets.
    return { message: "Unable to read BurnGate usage. Try again later." };
  }
}
