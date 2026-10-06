import { NextResponse } from "next/server";
import { enableTunnel } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";
import { tunnelSecurityBlockReason } from "@/lib/auth/tunnelGate";

const DNS_WARMUP_DELAY_MS = 8000;

export async function POST() {
  try {
    const settings = await getSettings();
    const blocked = tunnelSecurityBlockReason(settings);
    if (blocked) return NextResponse.json({ error: `Security required: ${blocked}` }, { status: 403 });

    const result = await enableTunnel();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor start failed:", error.message));
    // Wait for DNS warmup to propagate at Cloudflare edge after tunnel registered
    await new Promise((r) => setTimeout(r, DNS_WARMUP_DELAY_MS));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel enable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
