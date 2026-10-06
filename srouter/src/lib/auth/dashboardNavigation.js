import { evaluateLoginGate } from "./loginPolicy.js";

// Fetch Metadata cannot be forged by browser-page JavaScript. Only a deliberate
// top-level link navigation gets this exception, never a fetch, iframe or API.
export function isUserDashboardNavigation(request) {
  const pathname = request.nextUrl?.pathname;
  const headers = request.headers;
  return request.method === "GET"
    && (pathname === "/dashboard" || pathname?.startsWith("/dashboard/"))
    && !headers.get("origin")
    && headers.get("sec-fetch-site") === "cross-site"
    && headers.get("sec-fetch-mode") === "navigate"
    && headers.get("sec-fetch-dest") === "document"
    && headers.get("sec-fetch-user") === "?1";
}

export function evaluateDashboardLoginGate(request, settings) {
  if (!isUserDashboardNavigation(request)) return evaluateLoginGate(request, settings);
  const headers = new Headers(request.headers);
  headers.delete("sec-fetch-site");
  // Keep the local-peer, trusted Host and password-policy checks unchanged.
  return evaluateLoginGate({ headers }, settings);
}
