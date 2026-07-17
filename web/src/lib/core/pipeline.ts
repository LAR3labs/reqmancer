import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import type { DiscoveredOffer } from "./scan";

/**
 * "Add to pipeline" — appends user-selected discovered offers to data/pipeline.md
 * AND records them in data/scan-history.tsv (so future scans dedup them). We reuse
 * the CANONICAL writers exported by the core's scan.mjs (`appendToPipeline`,
 * `appendToScanHistory`) instead of re-implementing the line format / section
 * markers — single source of truth, per the web↔core contract. We invoke them in
 * a short-lived node process (cwd = the user's career-ops root) so the core's own
 * code does the writing; the web never owns a parallel copy of that logic.
 *
 * Discovered-but-not-added offers stay "new" (a dry-run scan writes nothing);
 * only an explicit add records them as seen. No tokens are spent here.
 */
export type AddResult = { added: number; error?: string };

// ISO YYYY-MM-DD → epoch ms at UTC midnight. Shape alone isn't enough: Date.parse
// rolls non-calendar dates like 2024-02-31 into a different day, so require the
// parsed value to round-trip back to the original string.
function postedAtMs(postedAt: unknown): number | undefined {
  if (typeof postedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(postedAt)) return undefined;
  const ms = Date.parse(`${postedAt}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== postedAt) return undefined;
  return ms;
}

function cleanOffers(offers: DiscoveredOffer[]) {
  return offers
    .filter((o) => o && typeof o.url === "string" && /^https?:\/\//i.test(o.url))
    .map((o) => ({
      url: o.url,
      company: o.company || "",
      title: o.title || "",
      location: o.location || "",
      source: o.source || o.ats || "explorer",
      // Preserve the provider's posting date so formatPipelineOffer can emit its
      // labeled `posted:` segment. The core writer expects epoch ms (see
      // postedAtIsoDate in scan.mjs); DiscoveredOffer carries ISO YYYY-MM-DD.
      postedAt: postedAtMs(o.postedAt),
      // Preserve the optional per-offer signal so it survives to pipeline.md.
      // The core writer treats an empty note as absent (byte-identical output).
      note: o.note || "",
    }));
}

export function addOffersToPipeline(offers: DiscoveredOffer[]): Promise<AddResult> {
  return runCoreWriter(offers, `appendToPipeline(offers); appendToScanHistory(offers, date, "added");`);
}

/**
 * "Not interested" — records the URLs in data/scan-history.tsv with status
 * `dismissed` WITHOUT touching data/pipeline.md. The core's dedup treats any
 * non-`added` status as permanently seen (shouldDedupScanHistoryRow), so a
 * dismissed posting stops resurfacing in every scanner — free Explore scans,
 * AI Discover's dedup context, and the home's "What's new" loop — while never
 * cluttering the pipeline page. Append-only, same canonical writer as Add.
 */
export function dismissOffers(offers: DiscoveredOffer[]): Promise<AddResult> {
  return runCoreWriter(offers, `appendToScanHistory(offers, date, "dismissed");`);
}

function runCoreWriter(offers: DiscoveredOffer[], writeStmts: string): Promise<AddResult> {
  const clean = cleanOffers(offers);
  if (clean.length === 0) return Promise.resolve({ added: 0 });

  // Data-only / pre-scan-ats checkout has no scan.mjs writers → fail with an
  // actionable message instead of a silent added:0.
  if (!fs.existsSync(rootScript("scan"))) {
    return Promise.resolve({ added: 0, error: "This checkout is data-only — the pipeline writer (scan.mjs) isn't available." });
  }

  const scanUrl = pathToFileURL(rootScript("scan")).href;
  const code = `
import { appendToPipeline, appendToScanHistory } from ${JSON.stringify(scanUrl)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  try {
    const offers = JSON.parse(input);
    const date = new Date().toISOString().slice(0, 10);
    ${writeStmts}
    process.stdout.write(JSON.stringify({ added: offers.length }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: String((e && e.message) || e) }));
  }
});
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ added: 0, error: e instanceof Error ? e.message : "spawn failed" }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim() || "{}") as AddResult;
        resolve({ added: parsed.added ?? 0, error: parsed.error });
      } catch {
        resolve({ added: 0, error: err.trim().slice(0, 200) || "writer returned no result" });
      }
    });
    child.stdin.write(JSON.stringify(clean));
    child.stdin.end();
  });
}
