import { isTrustedInternalRequest } from "@/sse/services/internalTrust.js";
import { getSettings } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "./dashboardSession.js";
import { evaluateLoginGate } from "./loginPolicy.js";

export async function isAuthorizedDashboardRequest(request) {
  if (await isTrustedInternalRequest(request)) return true;
  const cookieToken =
    request.cookies.get("srouter_auth_token")?.value ||
    request.cookies.get("auth_token")?.value;
  if (await verifyDashboardAuthToken(cookieToken)) return true;
  try {
    const settings = await getSettings();
    return evaluateLoginGate(request, settings).bypass;
  } catch {
    return false;
  }
}

export async function requireDashboardAuth(request) {
  return isAuthorizedDashboardRequest(request);
}
