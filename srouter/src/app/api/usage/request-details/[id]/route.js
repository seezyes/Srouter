import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";
import { redactRequestDetail } from "@/shared/utils/requestDetailRedaction.js";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (typeof id !== "string" || !id.trim() || id.length > 200) {
      return NextResponse.json({ error: "Invalid request detail id" }, { status: 400 });
    }
    const detail = await getRequestDetailById(id);
    if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ detail: redactRequestDetail(detail) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to fetch detail" }, { status: 500 });
  }
}
