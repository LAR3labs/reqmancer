import { NextRequest } from "next/server";
import fs from "node:fs";
import { runDiscovery, runPortalScan } from "@/lib/core/scan";
import { rootScript } from "@/lib/career-ops";
import { parseExplorePatch, DEFAULT_FILTERS, type DiscoveredOffer, type ScanEvent } from "@/lib/explore";

// Discovery is HTTP-bound across many ATS boards; give it room. It is FREE —
// zero LLM tokens (the scanner only does HTTP + JSON, and --dry-run writes nothing).
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty body → defaults */
  }

  const filters = parseExplorePatch(body, DEFAULT_FILTERS);

  // Guard: a data-only checkout (or pre-onboarding) has no scanner. Fail soft.
  if (!fs.existsSync(rootScript("scan-ats-full"))) {
    return Response.json(
      { error: "The discovery scanner isn't available in this checkout yet." },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  // `closed` + the heartbeat timer live in the OUTER scope so cancel() can stop
  // them even after start() has walked away (same shape as lib/core/cli-stream.ts).
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      let lastSent = Date.now();
      // Idempotent — must run on EVERY terminal path, including the
      // enqueue-failure path, or the interval fires forever (cf. 8151723).
      const cleanupTimers = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
      };
      const sendRaw = (s: string) => {
        if (closed || !s) return;
        try {
          controller.enqueue(encoder.encode(s));
          lastSent = Date.now();
        } catch {
          // Controller closed underneath us — stop, never crash.
          closed = true;
          cleanupTimers();
        }
      };
      const send = (obj: unknown) => sendRaw(JSON.stringify(obj) + "\n");

      // WebKit (Safari / the desktop app's WKWebView) fails the whole fetch with
      // a generic "Load failed" if the RESPONSE stays silent for ~60s
      // (NSURLSession's idle timeout). A free scan trips this easily: the Workday
      // leg alone runs 30s+ without emitting an event, and a tightly-filtered
      // search (few title matches) streams almost nothing for minutes. The
      // CLI-backed routes got this fix in ae9dcd6 (see api/assistant/route.ts and
      // api/run/route.ts); this route hand-rolls its stream and was left behind.
      // Whitespace-only chunks are invisible to the client parser (discover() in
      // components/explore/explore-provider.tsx skips empty lines).
      heartbeat = setInterval(() => {
        if (!closed && Date.now() - lastSent >= 15_000) sendRaw("\n");
      }, 15_000);

      send({
        kind: "start",
        ats: filters.includePortals ? [...filters.ats, "portals"] : filters.ats,
        sinceDays: filters.sinceDays,
        limit: filters.limitPerAts,
        free: true,
      } satisfies ScanEvent);
      // Both engines are zero-token HTTP scanners; run them in parallel and
      // merge (dedup by URL — a portals.yml company can also be in an ATS
      // dataset). Each engine dedups internally, so cross-engine dupes are
      // filtered here, at the shared stream, before the client sees them.
      const seen = new Set<string>();
      const sendDeduped = (e: ScanEvent) => {
        if (e.kind === "offer") {
          if (seen.has(e.offer.url)) return;
          seen.add(e.offer.url);
        }
        send(e);
      };
      let offers: DiscoveredOffer[] = [];
      try {
        const [atsOffers, portalOffers] = await Promise.all([
          filters.ats.length ? runDiscovery(filters, sendDeduped) : Promise.resolve([]),
          filters.includePortals ? runPortalScan(filters, sendDeduped) : Promise.resolve([]),
        ]);
        const merged = new Set(atsOffers.map((o) => o.url));
        offers = [...atsOffers, ...portalOffers.filter((o) => !merged.has(o.url))];
      } catch (err) {
        send({ kind: "error", message: err instanceof Error ? err.message : "discovery failed" } satisfies ScanEvent);
      }
      send({ kind: "done", count: offers.length, offers, cost: { tokens: 0, usd: 0 } } satisfies ScanEvent);
      cleanupTimers();
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    // The client navigated away / aborted: stop the heartbeat so it can't
    // outlive the request and enqueue onto a dead controller.
    cancel() {
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
