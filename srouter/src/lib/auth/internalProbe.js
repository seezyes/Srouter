// Trust boundary for the server's own diagnostic probes.
//
// The dashboard's "Test" button probes a model by calling the public
// /api/v1/chat/completions endpoint over loopback (/api/models/test ->
// pingModelByKind). That endpoint must keep enforcing account pools for normal
// traffic, but a diagnostic probe has to reach any active account: a freshly
// added custom model is not listed by any pool yet, and pool membership would
// otherwise turn a healthy account into "No active credentials".
//
// The bypass is granted only to a request that proves it is the server's own
// probe:
//   - x-9r-cli-token must EQUAL the machine-bound CLI secret (the same check the
//     dashboard guard uses), and
//   - x-9r-internal-probe must carry the exact marker the server itself sends.
// A dashboard cookie, a loopback peer address or a valid API key never qualify
// on their own — those are all things a remote client can hold, and the marker
// is not a secret by itself.
import { isTrustedInternalRequest } from "@/sse/services/internalTrust.js";

export const INTERNAL_PROBE_HEADER = "x-9r-internal-probe";
export const INTERNAL_PROBE_MODEL_TEST = "model-test";

/**
 * True when the request is the server's own authenticated diagnostic probe.
 * @param {Request|null} request
 * @param {string} marker - expected probe marker
 * @returns {Promise<boolean>}
 */
export async function isTrustedInternalProbe(request, marker = INTERNAL_PROBE_MODEL_TEST) {
  // Cheap header check first: normal client traffic never carries the marker, so
  // the machine-secret read below only happens for actual probes.
  const probe = request?.headers?.get?.(INTERNAL_PROBE_HEADER);
  if (probe !== marker) return false;

  return isTrustedInternalRequest(request);
}
