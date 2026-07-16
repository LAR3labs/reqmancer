import { NextRequest } from "next/server";
import { dismissOffers } from "@/lib/core/pipeline";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Not interested" — free: append the chosen offers to data/scan-history.tsv with
// status `dismissed` (via the core's CANONICAL writer, no parallel format). They
// never touch data/pipeline.md, and every future scan dedups them out. No tokens.
export async function POST(req: NextRequest) {
  let offers: DiscoveredOffer[] = [];
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[] };
    offers = Array.isArray(body.offers) ? body.offers : [];
  } catch {
    return Response.json({ dismissed: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length === 0) return Response.json({ dismissed: 0 });

  const result = await dismissOffers(offers);
  return Response.json({ dismissed: result.added, error: result.error });
}
