import { NextRequest } from "next/server";
import { dismissOffers } from "@/lib/core/pipeline";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Not interested" — free: append the chosen offers to data/scan-history.tsv with
// status `dismissed` (via the core's CANONICAL writer, no parallel format). They
// never touch data/pipeline.md, and every future scan dedups them out. No tokens.
// Hard bounds on the payload before any parsing/child-process work: a whole
// Explore result set is a few hundred cards, and no real field approaches 2 KB.
const MAX_OFFERS = 500;
const MAX_FIELD = 2048;

export async function POST(req: NextRequest) {
  let offers: DiscoveredOffer[] = [];
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[] };
    offers = Array.isArray(body.offers) ? body.offers : [];
  } catch {
    return Response.json({ dismissed: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length > MAX_OFFERS) {
    return Response.json({ dismissed: 0, error: `too many offers (max ${MAX_OFFERS})` }, { status: 413 });
  }
  if (offers.some((o) => Object.values(o ?? {}).some((v) => typeof v === "string" && v.length > MAX_FIELD))) {
    return Response.json({ dismissed: 0, error: "offer field too large" }, { status: 413 });
  }
  if (offers.length === 0) return Response.json({ dismissed: 0 });

  const result = await dismissOffers(offers);
  return Response.json({ dismissed: result.added, urls: result.urls ?? [], error: result.error });
}
