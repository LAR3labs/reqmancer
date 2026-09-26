import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "../yaml-compat.mjs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { writeTempPortals, cleanupTempPortals } from "./portals";
import { resolveScanTimeoutMs, scanTimeoutMessage } from "./scan-timeout.mjs";
import { ATS_SOURCES, type DiscoveredOffer, type ExploreFilters, type ScanEvent } from "@/lib/explore";

export type { DiscoveredOffer, ScanEvent, AtsSource } from "@/lib/explore";
export { ATS_SOURCES } from "@/lib/explore";

/**
 * ACL for the discovery engine — orchestrates the REAL core scanner
 * `scan-ats-full.mjs` (reverse ATS discovery, a contract entry-point). We run it
 * with `--dry-run` so it writes NOTHING (the user reviews + chooses), point it at
 * an EPHEMERAL filter file (never the user's portals.yml), and surface its results.
 *
 * DISCOVERY IS FREE — zero LLM tokens (pure HTTP + JSON). Only evaluation costs
 * tokens, and that is triggered explicitly elsewhere.
 *
 * Two parse paths, chosen by probing the local scanner's source:
 *  • `--json` (#1199): stdout = ONE authoritative object (human progress → stderr),
 *    carrying capHit / datasetStatus / postingsDroppedNoDate so we can tell a
 *    DEGRADED scan (capped, stale/unreachable dataset, postings dropped for no date)
 *    from a genuinely EMPTY one. Preferred.
 *  • legacy: older local checkouts lack `--json`; we parse the human stdout text
 *    (convenient but not formally stable) and infer a looser summary.
 */

const OFFER_RE = /^\s*\+\s+\[([^\]]+)\]\s+(\S+)\s+\|\s+(.+)$/;
const ATS_START_RE = /⚙\s+(\S+)\s+—\s+(\d+)\s+companies/;
const PROGRESS_RE = /(\d+)\/(\d+)\s+scanned,\s+(\d+)\s+total matches/;
const ATS_DONE_RE = /done \((\d+) unreachable boards skipped\)/;
const COMPANIES_RE = /Companies scanned:\s+(\d+)/;
const UNREACHABLE_RE = /Unreachable boards:\s+(\d+)/;
const SUMMARY_RE = /New matches:\s+(\d+)/;

function firstMatch(title: string, positives: string[]): string | undefined {
  const lower = title.toLowerCase();
  for (const k of positives) if (k && lower.includes(k.toLowerCase())) return k;
  return undefined;
}

function parseOfferLine(source: string, date: string, rest: string): Omit<DiscoveredOffer, "url"> | null {
  const fields = rest.split(" | ");
  if (fields.length < 2) return null;
  const company = fields[0].trim();
  const title = fields[1].trim();
  const location = fields.slice(2).join(" | ").trim();
  if (!company || !title) return null;
  return {
    company,
    title,
    location: location === "N/A" ? "" : location,
    postedAt: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    ats: source.replace(/-full$/, ""),
    source,
  };
}

// Does the user's LOCAL scanner support the --json contract (#1199)? Probe the
// source (cheap, no spawn) so older checkouts fall back instead of breaking on an
// unknown flag — the web is local-first, so the version is whatever they installed.
export function scannerSupportsJson(): boolean {
  try {
    const src = fs.readFileSync(rootScript("scan-ats-full"), "utf8");
    return src.includes("--json") && src.includes("capHit");
  } catch {
    return false;
  }
}

type JsonOffer = { company?: string; title?: string; url?: string; location?: string | null; postedAt?: string | null; source?: string };
type ScanJson = {
  companiesAvailable?: number;
  companiesScanned?: number;
  capHit?: boolean;
  datasetStatus?: Record<string, "ok" | "stale" | "empty">;
  postingsKept?: number;
  postingsDroppedNoDate?: number;
  unreachableBoards?: number;
  stoppedEarly?: boolean;
  offers?: JsonOffer[];
};

// ── Portal scan (scan.mjs + the user's own portals.yml) ─────────────────────
//
// Same ACL discipline as runDiscovery: the REAL core scanner does the work, we
// only spawn + parse. `--dry-run --portal-scan-json` (schema portal-scan/v1) writes NOTHING
// and reserves stdout for one authoritative result object (human progress →
// stderr, surfaced as log events). Filters come from the user's portals.yml —
// this is deliberately "my portals, as configured", not the UI chips.

export function portalScannerSupportsJson(): boolean {
  try {
    const src = fs.readFileSync(rootScript("scan"), "utf8");
    return src.includes("portal-scan/v1") && src.includes("--portal-scan-json");
  } catch {
    return false;
  }
}

type PortalScanJson = {
  schema?: string;
  companiesScanned?: number;
  boardsScanned?: number;
  offers?: JsonOffer[];
  errors?: number;
};

export function runPortalScan(
  filters: ExploreFilters,
  onEvent: (e: ScanEvent) => void,
  signal?: AbortSignal,
): Promise<DiscoveredOffer[]> {
  return new Promise((resolve) => {
    // On a portals-only run (no ATS engine to emit its own summary), a bail-out
    // must still send an empty summary — otherwise the client reads
    // companiesScanned=0 as "degraded" instead of a clean empty result. Mirrors
    // the success-path compensation below.
    const emitEmptySummaryIfPortalsOnly = () => {
      if (filters.ats.length === 0) {
        onEvent({ kind: "summary", companiesScanned: 0, unreachable: 0, matches: 0 });
      }
    };
    if (!portalScannerSupportsJson()) {
      onEvent({ kind: "log", line: "Portal scan skipped — this checkout's scan.mjs has no --portal-scan-json support." });
      emitEmptySummaryIfPortalsOnly();
      resolve([]);
      return;
    }
    if (!fs.existsSync(`${careerOpsRoot()}/portals.yml`)) {
      onEvent({ kind: "log", line: "Portal scan skipped — no portals.yml yet (run onboarding)." });
      emitEmptySummaryIfPortalsOnly();
      resolve([]);
      return;
    }
    onEvent({ kind: "atsStart", ats: "portals", companies: 0 });

    // --since mirrors runDiscovery: the Explore "posted within" window governs
    // both engines. Best-effort on this side — postings whose provider reports
    // no date still pass (scan.mjs buildPostingAgeFilter semantics).
    const child = spawn(process.execPath, [rootScript("scan"), "--dry-run", "--portal-scan-json", "--since", String(Math.max(1, filters.sinceDays || 7))], {
      cwd: careerOpsRoot(),
      env: { ...process.env },
    });

    // The client went away (route cancel()): stop the scanner instead of letting
    // it run to its timeout with nobody reading the result.
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", () => signal?.removeEventListener("abort", onAbort));

    const offers: DiscoveredOffer[] = [];
    const seen = new Set<string>();
    let jsonOut = "";
    let errBuf = "";
    // scan.mjs has no SIGTERM handler in --portal-scan-json mode, so a timed-out
    // run exits without its JSON. Remember that we stopped it, so the close
    // handler reports a timeout instead of "no readable output", and force-kill
    // a child that ignores SIGTERM so it can't hold the stream open.
    const PORTAL_SCAN_TIMEOUT_MS = 230_000;
    let timedOut = false;
    let hardKiller: ReturnType<typeof setTimeout> | undefined;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      hardKiller = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5_000);
    }, PORTAL_SCAN_TIMEOUT_MS);

    // Decode as a stream: toString() per chunk splits multibyte characters
    // ("Nestlé") that straddle a pipe-chunk boundary into U+FFFD.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      jsonOut += d;
    });
    child.stderr.on("data", (d: string) => {
      errBuf += d;
      const parts = errBuf.split(/\r?\n/);
      errBuf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) onEvent({ kind: "log", line: p.trim() });
    });

    child.on("error", (e) => {
      clearTimeout(killer);
      if (hardKiller) clearTimeout(hardKiller);
      onEvent({ kind: "error", message: e instanceof Error ? e.message : "portal scanner failed to start" });
      resolve(offers);
    });
    child.on("close", () => {
      clearTimeout(killer);
      if (hardKiller) clearTimeout(hardKiller);
      // --portal-scan-json keeps stdout to one portal-scan/v1 object. Match it
      // by schema per line anyway, so a stray line can't hide the result.
      let j: PortalScanJson | null = null;
      for (const line of jsonOut.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as PortalScanJson;
          if (parsed?.schema === "portal-scan/v1") j = parsed;
        } catch {
          /* not a JSON line — skip */
        }
      }
      if (j?.schema === "portal-scan/v1" && Array.isArray(j.offers)) {
        for (const o of j.offers) {
          const url = (o.url || "").trim();
          if (!url || seen.has(url) || !o.company || !o.title) continue;
          seen.add(url);
          const source = o.source || "portals";
          const offer: DiscoveredOffer = {
            company: o.company,
            title: o.title,
            location: o.location || "",
            postedAt: o.postedAt || "",
            ats: source.replace(/-api$/, ""),
            source,
            url,
            matchedKeyword: firstMatch(o.title, filters.positive),
          };
          offers.push(offer);
          onEvent({ kind: "offer", offer });
        }
        onEvent({ kind: "atsDone", ats: "portals", unreachable: j.errors ?? 0 });
        // Portals-only run: no ATS engine will emit the summary, and without one
        // the client reads companiesScanned=0 as "degraded" — supply it here.
        // When the ATS engine also runs, ITS summary is authoritative (skip ours).
        if (filters.ats.length === 0) {
          onEvent({
            kind: "summary",
            companiesScanned: (j.companiesScanned ?? 0) + (j.boardsScanned ?? 0),
            unreachable: j.errors ?? 0,
            matches: offers.length,
          });
        }
      } else {
        onEvent({
          kind: "error",
          message: timedOut
            ? `The portal scan was stopped after ${PORTAL_SCAN_TIMEOUT_MS / 1000}s before it finished.`
            : "The portal scanner returned no readable output.",
        });
      }
      resolve(offers);
    });
  });
}

// Scan budget (ms) from config/profile.yml `scan.timeout_seconds` — the same
// place `scan.extractor` lives. Never throws: a missing/malformed profile keeps
// the default (a broken config must not block scanning).
function readScanTimeoutMs(): number {
  try {
    const parsed = yaml.load(fs.readFileSync(path.join(careerOpsRoot(), "config", "profile.yml"), "utf8"));
    return resolveScanTimeoutMs(parsed);
  } catch {
    return resolveScanTimeoutMs(undefined);
  }
}

export function runDiscovery(
  filters: ExploreFilters,
  onEvent: (e: ScanEvent) => void,
  signal?: AbortSignal,
): Promise<DiscoveredOffer[]> {
  return new Promise((resolve) => {
    const tempPortals = writeTempPortals(filters);
    const ats = (filters.ats.length ? filters.ats : [...ATS_SOURCES]).filter((a) => (ATS_SOURCES as readonly string[]).includes(a));
    const useJson = scannerSupportsJson();
    const args = [
      rootScript("scan-ats-full"),
      "--dry-run",
      "--since",
      String(Math.max(1, filters.sinceDays || 7)),
      "--ats",
      ats.join(","),
      "--limit",
      String(Math.max(1, filters.limitPerAts || 150)),
    ];
    if (useJson) args.push("--json");

    const child = spawn(process.execPath, args, {
      cwd: careerOpsRoot(),
      env: { ...process.env, CAREER_OPS_PORTALS: tempPortals },
    });

    // The client went away (route cancel()): stop the scanner instead of letting
    // it run to its timeout with nobody reading the result.
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", () => signal?.removeEventListener("abort", onAbort));

    const offers: DiscoveredOffer[] = [];
    const seen = new Set<string>();
    let currentAts: string = ats[0] || "";
    let pending: Omit<DiscoveredOffer, "url"> | null = null;
    let companiesScanned = 0;
    let unreachable = 0;
    let outBuf = "";
    let errBuf = "";
    let jsonOut = ""; // --json mode: the single stdout object accumulates here

    // A broad ATS sweep can legitimately outlast the default budget (the scanner
    // probes every company in a source, not just --limit of them). Extend it in
    // config/profile.yml via scan.timeout_seconds. If our own timer fires, remember
    // it so the close handler can say so honestly (and the scanner flushes the
    // matches found so far as a partial --json result on SIGTERM).
    const timeoutMs = readScanTimeoutMs();
    let timedOut = false;
    let hardKiller: ReturnType<typeof setTimeout> | undefined;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Grace period: if the child can't flush its partial JSON and exit, force it
      // so a wedged scan can't hold the request open to the route's maxDuration.
      hardKiller = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5_000);
    }, timeoutMs);

    // Live progress (atsStart / progress / atsDone) — in --json mode these human
    // lines arrive on STDERR; in legacy mode on STDOUT (handled inside handleLine).
    const handleProgressLine = (line: string) => {
      const atsM = line.match(ATS_START_RE);
      if (atsM) {
        currentAts = atsM[1];
        onEvent({ kind: "atsStart", ats: atsM[1], companies: Number(atsM[2]) });
        return;
      }
      const progM = line.match(PROGRESS_RE);
      if (progM) {
        onEvent({ kind: "progress", ats: currentAts, scanned: Number(progM[1]), total: Number(progM[2]), matches: Number(progM[3]) });
        return;
      }
      const doneAtsM = line.match(ATS_DONE_RE);
      if (doneAtsM) {
        onEvent({ kind: "atsDone", ats: currentAts, unreachable: Number(doneAtsM[1]) });
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (pending && /^https?:\/\//i.test(trimmed)) {
        const url = trimmed.split(/\s+/)[0];
        if (!seen.has(url)) {
          seen.add(url);
          const offer: DiscoveredOffer = { ...pending, url, matchedKeyword: firstMatch(pending.title, filters.positive) };
          offers.push(offer);
          onEvent({ kind: "offer", offer });
        }
        pending = null;
        return;
      }
      if (pending) pending = null;

      const offerM = line.match(OFFER_RE);
      if (offerM) {
        pending = parseOfferLine(offerM[1], offerM[2], offerM[3]);
        return;
      }
      const atsM = line.match(ATS_START_RE);
      if (atsM) {
        currentAts = atsM[1];
        onEvent({ kind: "atsStart", ats: atsM[1], companies: Number(atsM[2]) });
        return;
      }
      const progM = line.match(PROGRESS_RE);
      if (progM) {
        onEvent({ kind: "progress", ats: currentAts, scanned: Number(progM[1]), total: Number(progM[2]), matches: Number(progM[3]) });
        return;
      }
      const doneAtsM = line.match(ATS_DONE_RE);
      if (doneAtsM) {
        onEvent({ kind: "atsDone", ats: currentAts, unreachable: Number(doneAtsM[1]) });
        return;
      }
      const compM = line.match(COMPANIES_RE);
      if (compM) {
        companiesScanned = Number(compM[1]);
        return;
      }
      const unreachM = line.match(UNREACHABLE_RE);
      if (unreachM) {
        unreachable = Number(unreachM[1]);
        return;
      }
      const sumM = line.match(SUMMARY_RE);
      if (sumM) {
        onEvent({ kind: "summary", companiesScanned, unreachable, matches: Number(sumM[1]) });
        return;
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      if (useJson) {
        jsonOut += d.toString(); // one JSON object — parsed at close
        return;
      }
      outBuf += d.toString();
      const parts = outBuf.split(/\r\n|\r|\n/);
      outBuf = parts.pop() ?? "";
      for (const p of parts) handleLine(p);
    });
    child.stderr.on("data", (d: Buffer) => {
      errBuf += d.toString();
      const parts = errBuf.split(/\r?\n/);
      errBuf = parts.pop() ?? "";
      for (const p of parts) {
        if (!p.trim()) continue;
        if (useJson) handleProgressLine(p); // human progress lives on stderr in --json mode
        onEvent({ kind: "log", line: p.trim() });
      }
    });

    child.on("error", (e) => {
      clearTimeout(killer);
      if (hardKiller) clearTimeout(hardKiller);
      cleanupTempPortals(tempPortals);
      onEvent({ kind: "error", message: e instanceof Error ? e.message : "scanner failed to start" });
      resolve(offers);
    });
    child.on("close", () => {
      clearTimeout(killer);
      if (hardKiller) clearTimeout(hardKiller);
      cleanupTempPortals(tempPortals);
      if (useJson) {
        let j: ScanJson | null = null;
        try {
          j = JSON.parse(jsonOut.trim()) as ScanJson;
        } catch {
          j = null;
        }
        if (j && Array.isArray(j.offers)) {
          for (const o of j.offers) {
            const url = (o.url || "").trim();
            if (!url || seen.has(url) || !o.company || !o.title) continue;
            seen.add(url);
            const source = o.source || `${currentAts}-full`;
            const offer: DiscoveredOffer = {
              company: o.company,
              title: o.title,
              location: o.location || "",
              postedAt: o.postedAt || "",
              ats: source.replace(/-full$/, ""),
              source,
              url,
              matchedKeyword: firstMatch(o.title, filters.positive),
            };
            offers.push(offer);
            onEvent({ kind: "offer", offer });
          }
          onEvent({
            kind: "summary",
            companiesScanned: j.companiesScanned ?? 0,
            unreachable: j.unreachableBoards ?? 0,
            matches: j.postingsKept ?? offers.length,
            companiesAvailable: j.companiesAvailable,
            capHit: j.capHit,
            datasetStatus: j.datasetStatus,
            postingsDroppedNoDate: j.postingsDroppedNoDate,
          });
          // Stopped before finishing (our budget, or the scanner self-limited): the
          // offers above are what it found so far — surface WHY without discarding them.
          if (timedOut || j.stoppedEarly) {
            const found = offers.length ? ` Showing the ${offers.length} match${offers.length === 1 ? "" : "es"} found so far.` : "";
            onEvent({ kind: "error", message: scanTimeoutMessage(timeoutMs) + found });
          }
        } else {
          // No parseable JSON. Either our timer stopped the scanner before it could
          // emit its single stdout object (a full sweep outran the budget), or —
          // defensively — the probe passed yet stdout still didn't parse. Say which.
          onEvent({
            kind: "error",
            message: timedOut ? scanTimeoutMessage(timeoutMs) : "The scanner returned no readable output.",
          });
        }
        resolve(offers);
        return;
      }
      if (outBuf.trim()) handleLine(outBuf);
      // Legacy mode streams offers as they arrive, so any collected so far are
      // returned; still tell the user the run was cut short if our timer fired.
      if (timedOut) onEvent({ kind: "error", message: scanTimeoutMessage(timeoutMs) });
      resolve(offers);
    });
  });
}
