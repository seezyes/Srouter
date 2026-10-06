import { NextResponse } from "next/server";
import { enableTailscale } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";
import { tunnelSecurityBlockReason } from "@/lib/auth/tunnelGate";

export async function POST() {
  try {
    const settings = await getSettings();
    const blocked = tunnelSecurityBlockReason(settings);
    if (blocked) return NextResponse.json({ error: `Security required: ${blocked}` }, { status: 403 });

    const result = await enableTailscale();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tailscale monitor start failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale enable error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
