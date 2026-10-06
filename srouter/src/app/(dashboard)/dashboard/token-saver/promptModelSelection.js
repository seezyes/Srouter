// Keep picker display values separate from canonical IDs persisted in settings.
export function promptTargetKey(raw, canonicalize, prefixes = []) {
  if (raw && typeof raw === "object" && (raw.isPlaceholder || (raw.kind && raw.kind !== "llm"))) return "";
  const value = typeof raw === "string" ? raw : raw?.value;
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  const prefix = trimmed.slice(0, slash);
  const provider = prefixes.find((item) => item.prefix === prefix)?.provider;
  return canonicalize(provider && slash > 0 ? `${provider}${trimmed.slice(slash)}` : trimmed);
}

export function promptPickerValues(keys, getAlias, prefixes = []) {
  const values = new Set(keys);
  for (const key of keys) {
    const slash = key.indexOf("/");
    const provider = key.slice(0, slash);
    const suffix = key.slice(slash);
    values.add(`${getAlias(provider)}${suffix}`);
    for (const item of prefixes) {
      if (item.provider === provider && item.prefix) values.add(`${item.prefix}${suffix}`);
    }
  }
  return [...values];
}

// A bad token or over-limit paste rejects the entire batch, preserving targets.
export function mergePromptTargets(existing, raw, canonicalize, limits, prefixes = []) {
  const tokens = typeof raw === "string" ? raw.trim().split(/[\s,;]+/).filter(Boolean) : [raw];
  if (!tokens.length) return { error: "Enter at least one provider/model ID." };
  const keys = tokens.map((token) => promptTargetKey(token, canonicalize, prefixes));
  if (keys.some((key) => !key || key.length > limits.model)) {
    return { error: "Use provider/model IDs, separated by commas or newlines. Combo IDs are not targets." };
  }
  const models = [...new Set([...existing, ...keys])];
  if (models.length > limits.models) return { error: `At most ${limits.models} model targets per prompt.` };
  return { models };
}
