import { NextRequest } from "next/server";
import { checkLiveness } from "@/lib/core/liveness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only check for streamed AI and Deep candidates. Uses an ATS API when
// available and a browser for page-level expiry and posting-date evidence.
export async function POST(req: NextRequest) {
  let urls: string[] = [];
  try {
    const body = (await req.json()) as { urls?: string[] };
    urls = Array.isArray(body.urls) ? body.urls : [];
  } catch {
    return Response.json({ results: [], error: "bad request" }, { status: 400 });
  }
  if (urls.length === 0) return Response.json({ results: [] });
  return Response.json({ results: await checkLiveness(urls) });
}
