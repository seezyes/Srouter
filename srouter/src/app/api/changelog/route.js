import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One source for the repository and dashboard; bundled by outputFileTracingIncludes.
export async function GET() {
  try {
    const markdown = await readFile(join(process.cwd(), "CHANGELOG.md"), "utf8");
    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Srouter changelog is unavailable.", { status: 503 });
  }
}
