// Client-safe (NO node imports) tolerant streaming parser for the AI-search
// `<<offer:{...}>>` envelopes emitted by modes/discover.md. Modeled on the
// assistant console's <<act:>> envelope parsing, factored out so the grammar
// can't drift. The load-bearing requirement: an envelope (or its opener) split
// across stream chunk boundaries must BUFFER, never flush as garbage or drop.

import type { DiscoveredOffer } from "./explore";

const OPEN = "<<offer:";
const CLOSE = ">>";

export type AiTraceChunk =
  | { kind: "offer"; offer: DiscoveredOffer }
  | { kind: "narration"; text: string }
  | { kind: "malformed"; raw: string };

/** Normalize a URL for dedup: host+path, lowercased, no query/fragment/trailing slash. */
export function canon(u: string): string {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).toLowerCase().replace(/\/$/, "");
  } catch {
    return u.toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

function toOffer(raw: unknown, source: string): DiscoveredOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const conf = o.confidence;
  return {
    url,
    company: str(o.company),
    title: str(o.title),
    location: str(o.location),
    postedAt: "", // AI gives only a human postedHint, never a trustworthy date
    ats: str(o.ats) || "other",
    // Trusted from the CALLER, never from the agent's own envelope — the source
    // is what lands in data/scan-history.tsv, so "which surface found this" must
    // stay attributable (ai-search vs deep-search) for later pattern analysis.
    source,
    verification: "unconfirmed",
    why: str(o.why) || undefined,
    postedHint: str(o.postedHint) || undefined,
    confidence: conf === "low" || conf === "medium" || conf === "high" ? conf : undefined,
  };
}

export function makeAiStreamParser(opts?: {
  knownUrls?: Set<string>;
  /** Location predicate (see explore.ts::buildLocationMatcher). AI search is the
   *  one discovery path the core's location filter never reached — modes/discover.md
   *  tells the agent to be a "GENEROUS FINDER" and include roles whose location it
   *  can't confirm, so without this an explicitly-blocked region lands in results.
   *  Rejected offers are counted, not silently vanished, so the UI can say why. */
  locationOk?: (location: string) => boolean;
  /** Which Explore surface is streaming — stamped onto every offer. Defaults to
   *  "ai-search"; the Deep search tab passes "deep-search". */
  source?: string;
}) {
  const known = opts?.knownUrls ?? new Set<string>();
  const locationOk = opts?.locationOk ?? (() => true);
  const source = opts?.source || "ai-search";
  const seen = new Set<string>();
  let rejectedByLocation = 0;
  let buf = "";

  return {
    feed(delta: string): AiTraceChunk[] {
      buf += delta;
      const out: AiTraceChunk[] = [];
      for (;;) {
        const open = buf.indexOf(OPEN);
        if (open === -1) {
          // No opener in view. Flush as narration — but hold back the trailing
          // fragment of a split opener ("<<offe…").
          //
          // This used to test ONLY the fixed-width 7-char tail: a buffer ending
          // in a SHORTER fragment ("…text\n<<") failed `OPEN.startsWith(tail)`
          // and the whole buffer — opener included — was flushed as narration.
          // The stream never recovered: that envelope and EVERY envelope after
          // it degraded into narration text, so an AI hunt could silently lose
          // most of its candidates depending on where chunk boundaries landed.
          // Hold back the LONGEST suffix that is a prefix of OPEN instead.
          let keep = 0;
          for (let n = Math.min(OPEN.length - 1, buf.length); n > 0; n--) {
            if (OPEN.startsWith(buf.slice(buf.length - n))) {
              keep = n;
              break;
            }
          }
          const text = keep ? buf.slice(0, buf.length - keep) : buf;
          if (text.trim()) out.push({ kind: "narration", text });
          buf = keep ? buf.slice(buf.length - keep) : "";
          break;
        }
        const before = buf.slice(0, open);
        if (before.trim()) out.push({ kind: "narration", text: before });
        const close = buf.indexOf(CLOSE, open + OPEN.length);
        if (close === -1) {
          // Envelope still streaming — keep from the opener onward and wait.
          buf = buf.slice(open);
          break;
        }
        const json = buf.slice(open + OPEN.length, close);
        buf = buf.slice(close + CLOSE.length);
        let offer: DiscoveredOffer | null = null;
        try {
          offer = toOffer(JSON.parse(json), source);
        } catch {
          offer = null;
        }
        if (!offer) {
          out.push({ kind: "malformed", raw: json.slice(0, 120) });
          continue;
        }
        const key = canon(offer.url);
        if (seen.has(key) || known.has(key)) continue; // intra-run + known dedup
        seen.add(key);
        if (!locationOk(offer.location)) {
          rejectedByLocation++;
          continue;
        }
        out.push({ kind: "offer", offer });
      }
      return out;
    },
    /** Emit any trailing buffered narration when the stream ends. */
    flush(): AiTraceChunk[] {
      const text = buf;
      buf = "";
      return text.trim() ? [{ kind: "narration" as const, text }] : [];
    },
    /** How many well-formed, non-duplicate candidates the location filter dropped.
     *  Surfaced in the run status so a thin result set is never a mystery. */
    locationRejects(): number {
      return rejectedByLocation;
    },
  };
}
