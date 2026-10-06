import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { isStrongInitialPassword } from "@/lib/auth/password.js";

// Set a strong replacement. Local-only enforcement remains in dashboardGuard.
export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const newPassword = body?.newPassword;
    if (!isStrongInitialPassword(newPassword)) {
      return NextResponse.json({ error: "New password must be at least 12 characters and not a placeholder" }, { status: 400 });
    }
    const password = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
    await updateSettings({ password });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
