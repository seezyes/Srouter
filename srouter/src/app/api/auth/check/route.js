import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { evaluateLoginGate } from "@/lib/auth/loginPolicy";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

// Upstream compatibility endpoint: VansRouter's /api/auth/check was used by
// upstream clients (CLI / external integrations) to ask "does this caller
// already count as authenticated?". Not a dashboard page dependency — it exists
// so upstream API consumers keep working against this fork.
//
// Contract (pin-exact, VansRouter 0.91.51 src/app/api/auth/check/route.js):
//   - login policy bypasses the session check  -> 200 { authenticated: true }
//   - no/invalid session cookie                -> 401 { authenticated: false }
//   - any internal error                       -> 401 { authenticated: false }
//
// The pin verified a raw JWT with jose against JWT_SECRET; this fork reuses its
// own auth code instead of duplicating that logic: the shared login-policy gate
// (evaluateLoginGate: policy level + origin guard) and the local dashboard
// session verifier for the srouter_auth_token cookie. The endpoint is NOT added
// to dashboardGuard's PUBLIC_API_PATHS — the pin does not list it as public
// either, so deny-by-default plus the login-policy bypass is the pinned
// behavior. Here the gate only decides the *answer*; middleware decides access.
export async function GET(request) {
  try {
    const settings = await getSettings();
    if (evaluateLoginGate(request, settings).bypass) {
      return NextResponse.json({ authenticated: true });
    }

    const cookieStore = await cookies();
    const token = cookieStore.get("srouter_auth_token")?.value;
    if (!token) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    const session = await verifyDashboardAuthToken(token);
    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({ authenticated: true });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}
