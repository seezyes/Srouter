// New device flows send credentials only to their configured endpoint, never
// across redirects. Bound every control-plane call, including its body read.
export function fetchOAuth(url, options = {}) {
  return fetch(url, { ...options, redirect: "error",
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
}
