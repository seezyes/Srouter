// Re-arm if the effective value changed while a confirmation was pending.
export function chooseProviderFeature(pending, key, enabled) {
  const value = !enabled;
  return pending?.key === key && pending.value === value
    ? { confirm: true, key, value }
    : { confirm: false, key, value };
}
