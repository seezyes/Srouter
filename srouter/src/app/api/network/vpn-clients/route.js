import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth";
import { discoverLocalVpnClients } from "@/lib/network/localVpnClients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await discoverLocalVpnClients(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Local discovery is unavailable. Enter the proxy URL from your VPN client manually." }, { status: 503 });
  }
}
