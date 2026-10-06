import { NextResponse } from "next/server";
import { getHostedSearchMetadata } from "@/lib/hostedSearch/registry.js";
import { HOSTED_TOOLS_WIP, HOSTED_TOOLS_WIP_MESSAGE } from "@/shared/constants/hostedTools.js";

export const dynamic = "force-dynamic";

// Read-only metadata. No plugin source, filesystem path, credentials, reload,
// upload or code editing endpoint exists.
export async function GET() {
  return NextResponse.json({
    adapters: await getHostedSearchMetadata(), restartRequired: true,
    available: true, status: HOSTED_TOOLS_WIP ? "local-plugins-only" : "available",
    builtinsAvailable: !HOSTED_TOOLS_WIP,
    ...(HOSTED_TOOLS_WIP ? { builtinsStatus: "wip", message: HOSTED_TOOLS_WIP_MESSAGE } : {}),
  });
}
