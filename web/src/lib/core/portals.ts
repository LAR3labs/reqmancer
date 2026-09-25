import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import { DEFAULT_FILTERS, cleanFilterList, type ExploreFilters } from "@/lib/explore";
import { profileTargetKeywords } from "@/lib/profile-keywords.mjs";

/**
 * ACL for portals.yml — the core's scan-filter config (a CONTRACT entry-point,
 * see reference_web_core_sync_protocol). The Explorer NEVER mutates the user's
 * real portals.yml: it writes an EPHEMERAL filter file and points the scanner at
 * it via CAREER_OPS_PORTALS, so an ad-hoc search can't clobber the curated config.
 * We also read the real portals.yml + config/profile.yml (tolerantly) only to
 * SEED sensible defaults for the first search.
 *
 * Filter semantics mirror scan.mjs::buildTitleFilter / buildLocationFilter:
 *   title positive → substring match (empty = everything matches)
 *   title negative → substring reject
 *   location block_hard > always_allow > block > allow (case-insensitive substring);
 *   block_hard is the one tier always_allow cannot override (scan.mjs, #2956)
 */
type FilterLists = Pick<ExploreFilters, "positive" | "negative" | "allow" | "block" | "alwaysAllow" | "blockHard"> & {
  allowBareRemote?: boolean;
};

// Uncapped on purpose: these lists come from the user's real portals.yml and are
// written back out as the ephemeral scanner config. Capping here silently dropped
// everything past the 16th block keyword, so an in-app scan enforced only half the
// user's location policy while `node scan.mjs` enforced all of it.
function listFrom(v: unknown): string[] {
  return cleanFilterList(v);
}

// serializePortals lives in portals-serialize.mjs (pure, no TS deps) so the web
// `node --test` suite can load it — the block_hard round-trip (#3102) is exactly
// a "don't silently drop a tier" property that has to be asserted, not eyeballed.
export { serializePortals } from "./portals-serialize.mjs";
import { serializePortals } from "./portals-serialize.mjs";

/** Write the ephemeral filter file to a temp path; caller cleans it up. */
export function writeTempPortals(f: FilterLists): string {
  const file = path.join(os.tmpdir(), `career-ops-explore-${randomUUID()}.yml`);
  fs.writeFileSync(file, serializePortals(f), "utf8");
  return file;
}

export function cleanupTempPortals(file: string): void {
  try {
    if (file.startsWith(os.tmpdir()) && file.includes("career-ops-explore-")) fs.unlinkSync(file);
  } catch {
    /* best-effort */
  }
}

function loadYaml(rel: string): Record<string, unknown> | null {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8"));
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Tolerantly seed first-search defaults from the user's real config. Reads
 * portals.yml (title_filter / location_filter) and falls back to
 * config/profile.yml (target_roles, location) for the positive keywords when
 * portals has none. Never throws — a bare checkout just yields DEFAULT_FILTERS.
 */
export function seedExploreFilters(): { filters: ExploreFilters; seededFrom: string[] } {
  const filters: ExploreFilters = { ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats] };
  const seededFrom: string[] = [];

  const portals = loadYaml("portals.yml");
  if (portals) {
    const tf = (portals.title_filter ?? {}) as Record<string, unknown>;
    const lf = (portals.location_filter ?? {}) as Record<string, unknown>;
    filters.positive = listFrom(tf.positive);
    filters.negative = listFrom(tf.negative);
    filters.allow = listFrom(lf.allow);
    filters.block = listFrom(lf.block);
    filters.alwaysAllow = listFrom(lf.always_allow);
    filters.allowBareRemote = lf.allow_bare_remote === true;
    filters.blockHard = listFrom(lf.block_hard);
    if (filters.positive.length || filters.allow.length || filters.block.length || filters.blockHard.length) seededFrom.push("portals.yml");
  }

  if (filters.positive.length === 0) {
    // Shape-reading lives in profile-keywords.mjs, mirroring the core's
    // providers/_profile-keywords.mjs. Inlined here it had drifted from the
    // core on BOTH fields — `primary` read as a string when it is a list,
    // `archetypes` spread raw when its entries are objects — so this fallback
    // returned nothing for every profile.yml the app itself writes.
    const fromRoles = listFrom(profileTargetKeywords(loadYaml("config/profile.yml")));
    if (fromRoles.length) {
      filters.positive = fromRoles;
      seededFrom.push("profile.yml");
    }
  }

  return { filters, seededFrom };
}

export { listFrom as normalizeKeywords };

/**
 * The user's curated broad-discovery searches from portals.yml `search_queries`.
 *
 * These are the ONLY sources neither zero-token scanner can reach — boards that
 * are bot-walled, auth-gated, or client-rendered, expressed as `site:` queries.
 * Before Deep search existed they were read only by agent `scan` mode Level 3,
 * which in practice never ran, so the coverage was configured but dead.
 *
 * Disabled entries are skipped, and so are duplicate queries: the Deep search
 * route puts every returned query in the prompt and the agent runs the list in
 * order, so a query repeated across two portals.yml entries is paid for twice
 * for the same results. First occurrence wins, keeping its name.
 *
 * Returns [] on a bare or malformed checkout.
 */
export function readSearchQueries(): Array<{ name: string; query: string }> {
  const portals = loadYaml("portals.yml");
  const raw = portals?.search_queries;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; query: string }> = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.enabled === false) continue;
    const query = typeof e.query === "string" ? e.query.trim() : "";
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : query.slice(0, 60);
    out.push({ name, query });
  }
  return out;
}

/** What "My portals" actually covers — the enabled job boards (by name) and the
 *  count of enabled tracked companies in the user's portals.yml. Rendered under
 *  the Sources chips so the data's origin is never a mystery. Best-effort: a
 *  bare checkout yields empty. */
export function portalSourceSummary(): { boards: string[]; companies: number } {
  const portals = loadYaml("portals.yml");
  const enabled = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? v.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && (e as Record<string, unknown>).enabled !== false) : [];
  const boards = enabled(portals?.job_boards)
    .map((b) => String(b.name ?? b.provider ?? "").trim())
    .filter(Boolean);
  return { boards: Array.from(new Set(boards)), companies: enabled(portals?.tracked_companies).length };
}
