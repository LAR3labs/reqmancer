import { NextRequest } from "next/server";
import { checkLiveness } from "@/lib/core/liveness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Free + read-only: confirms whether AI-search candidates are still live by
// hitting their own ATS APIs. No tokens, no browser, no writes. Called by the
// Explore client as candidates stream in, so a dead posting never reaches a card.
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
