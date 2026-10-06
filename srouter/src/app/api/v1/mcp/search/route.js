import { handleSrouterSearchMcp } from "@/lib/mcp/srouterSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = handleSrouterSearchMcp;

// Stateless Streamable HTTP: no standalone SSE stream or persistent sessions.
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
export const DELETE = GET;
