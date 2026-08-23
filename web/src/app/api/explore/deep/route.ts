import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { assembleDedupContext } from "@/lib/core/discover";
import { readSearchQueries } from "@/lib/core/portals";
import { streamCliPrompt } from "@/lib/core/cli-stream";

// Deep search — runs the user's OWN curated `search_queries` from portals.yml
// through their CLI's WebSearch. This is the third Explore surface and the only
// one that reaches the boards no zero-token scanner can: bot-walled (Wellfound),
// auth-gated (hiring.cafe), or client-rendered. Those queries previously existed
// only for agent `scan` mode Level 3, which in practice never ran.
//
// Cheaper than AI search by construction: the queries are already written, so
// there is no free-text interpretation and no planning step — just execute a
// known list. Same PROPOSER contract, same <<offer:…>> envelope, same
// review → Add → evaluate funnel. Nothing is persisted here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const OUTPUT_CONTRACT = `

--- OUTPUT CONTRACT (the career-ops WEB is parsing your stream) ---
Follow modes/discover.md's FINDER contract, with one difference: the search PLAN
is already decided. Do NOT invent your own queries or re-plan.
- You are a PROPOSER — never write a file (Write/Edit/Bash are disabled).
- Run the queries listed below with WebSearch, in order, exactly as written.
  They are the user's own curated searches; each targets a board that no
  automated scanner can reach. Skip a query only if it errors.
- Emit each posting you find as ONE line, never inside a code fence:
  <<offer:{"url":"…","title":"…","company":"…","location":"…","source":"deep-search","why":"…","postedHint":"…","ats":"…","verification":"unconfirmed"}>>
  Valid JSON, one per line, streamed the moment you have it.
- "why" names which query surfaced it and how it maps to the user's targets —
  it is a HINT, never a score or a fit verdict. The A–F evaluation judges later,
  with the full JD.
- Between envelopes, narrate briefly (plain text) which query you're running —
  shown live as your reasoning.
- Be a GENEROUS FINDER: search-result snippets are shallow. When seniority, comp,
  or company stage can't be confirmed, INCLUDE the posting and flag the
  uncertainty in "why" — don't discard it.
- Results from search engines can be STALE. Prefer postings that look current,
  and say so in "why" when a posting looks old. Everything is UNVERIFIED.
- DEDUP: skip anything already known below; don't re-propose the user's existing
  companies.
`;

/** The GET response shape. Exported so DeepSearchBox imports it instead of
 *  restating it — two declarations of the same wire shape drift silently. */
export type DeepSearchPlan = { count: number; queries: string[]; hosts: string[] };

/** What Deep search would run, so the UI can show the plan BEFORE spending. */
export async function GET() {
  const queries = readSearchQueries();
  const plan: DeepSearchPlan = {
    count: queries.length,
    queries: queries.map((q) => q.name),
    // The distinct hosts these queries target — the coverage story in one line.
    hosts: [
      ...new Set(
        queries.flatMap((q) => [...q.query.matchAll(/site:([\w.*-]+)/g)].map((m) => m[1].replace(/^\*\./, ""))),
      ),
    ],
  };
  return Response.json(plan);
}

export async function POST(req: Request) {
  let body: { cliId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const cliId = body.cliId;
  if (!cliId) return Response.json({ error: "cliId required" }, { status: 400 });

  // Canonical mode file — same single source of truth as AI search.
  let mode: string;
  try {
    mode = fs.readFileSync(path.join(careerOpsRoot(), "modes", "discover.md"), "utf8");
  } catch {
    return Response.json(
      { code: "MODE_MISSING", error: "Deep search needs a newer career-ops — update to enable it." },
      { status: 400 },
    );
  }

  const queries = readSearchQueries();
  if (queries.length === 0) {
    return Response.json(
      {
        code: "NO_QUERIES",
        error: "No search_queries configured in portals.yml — Deep search has nothing to run.",
      },
      { status: 400 },
    );
  }

  const { lines } = assembleDedupContext();
  const memory = readMemory();
  const memoryLine = memory.trim() ? `\n\nWHAT YOU KNOW ABOUT THE USER (persistent memory):\n${memory.trim()}` : "";
  const knownBlock = lines.length ? `\n\n--- ALREADY KNOWN (dedup — do NOT propose these) ---\n${lines.join("\n")}` : "";
  const queryBlock = queries.map((q, i) => `${i + 1}. [${q.name}]\n   ${q.query}`).join("\n");
  const prompt = `${mode}${OUTPUT_CONTRACT}${memoryLine}${knownBlock}\n\n--- CURATED SEARCHES TO RUN (${queries.length}, in order) ---\n${queryBlock}\n`;

  const result = streamCliPrompt({ prompt, cliId });
  if (result.kind === "error") return Response.json(result.body, { status: result.status });
  return result.response;
}
