// Server-side twin of the Endpoint page gate: a tunnel/tailscale funnel must never
// expose a dashboard that the login policy leaves open, or that still accepts the
// public default password. The UI shows the same reasons; keeping them here means
// the API cannot be talked into exposing an unprotected dashboard.
import { resolveLoginPolicy } from "@/lib/auth/loginPolicy";

/**
 * @returns {string|null} reason the tunnel must not be enabled, or null when safe.
 */
export function tunnelSecurityBlockReason(settings) {
  if (!settings?.password) {
    return "Set a custom dashboard password before activating the tunnel.";
  }
  if (resolveLoginPolicy(settings) === "off") {
    return 'Set the login policy to "Password always" or "No password on this computer" before activating the tunnel.';
  }
  return null;
}
