import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { originGuardEnabled, resolveLoginPolicy } from "@/lib/auth/loginPolicy";

export async function GET() {
  try {
    const settings = await getSettings();
    const loginPolicy = resolveLoginPolicy(settings);
    // Legacy field: false only for the "no login anywhere" level.
    const requireLogin = loginPolicy !== "off";
    const tunnelDashboardAccess = settings.tunnelDashboardAccess !== false;
    const tunnelUrl = settings.tunnelUrl || "";
    const tailscaleUrl = settings.tailscaleUrl || "";
    return NextResponse.json({
      requireLogin,
      loginPolicy,
      originGuard: originGuardEnabled(settings),
      tunnelDashboardAccess,
      tunnelUrl,
      tailscaleUrl,
    });
  } catch (error) {
    return NextResponse.json({ requireLogin: true, loginPolicy: "always", originGuard: true }, { status: 200 });
  }
}
