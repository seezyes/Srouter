import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { getSettings, updateSettings } from "@/lib/localDb";
import { isLocalRequest } from "@/lib/auth/localRequest";
import { originGuardEnabled, resolveLoginPolicy } from "@/lib/auth/loginPolicy";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const DEFAULT_PASSWORD = "123456";

// First-run helper for a fresh install (no password set yet). The login window on
// such an install is guarded only by the public default password, so from the
// machine itself the user may either set a real password or drop the login window
// for local requests. Both actions are local-only and only available while no
// password exists — once one is set, the policy is changed from Profile → Security
// with a session.
export async function POST(request) {
  try {
    if (!isLocalRequest(request)) {
      return NextResponse.json(
        { error: "Local only: first-run setup is available from the host machine." },
        { status: 403, headers: NO_STORE_HEADERS }
      );
    }

    const settings = await getSettings();
    if (settings.password) {
      return NextResponse.json(
        { error: "A password is already set. Sign in to change the login policy." },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }

    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    if (action === "no-login-local") {
      const next = await updateSettings({ requireLogin: "local" });
      return NextResponse.json(
        {
          success: true,
          loginPolicy: resolveLoginPolicy(next),
          originGuard: originGuardEnabled(next),
        },
        { headers: NO_STORE_HEADERS }
      );
    }

    if (action === "set-password") {
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
      if (!newPassword) {
        return NextResponse.json(
          { error: "Password is required" },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
      if (newPassword === DEFAULT_PASSWORD) {
        return NextResponse.json(
          { error: "The default password is public. Choose a different one." },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }

      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(newPassword, salt);
      const next = await updateSettings({ password: hash, requireLogin: true });

      // The password is set from the host machine's browser: hand out a session so
      // the user lands in the dashboard instead of typing the fresh password again.
      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);

      return NextResponse.json(
        {
          success: true,
          loginPolicy: resolveLoginPolicy(next),
          originGuard: originGuardEnabled(next),
        },
        { headers: NO_STORE_HEADERS }
      );
    }

    return NextResponse.json(
      { error: "Unknown first-run action" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
