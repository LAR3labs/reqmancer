import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

/**
 * Zero-token liveness gate for AI-search candidates.
 *
 * The deterministic scan is live by construction — it reads the ATS API, so a
 * posting it returns exists. AI search inherits whatever the web index served,
 * and search indexes lag reality by days: a candidate can 404 the moment you
 * click it. Every AI offer was already stamped `verification: "unconfirmed"`,
 * but nothing ever acted on that flag.
 *
 * This calls the core's `checkLivenessViaApi` (liveness-api.mjs) — the cheap
 * first rung of the liveness ladder: a direct GET against the posting's own ATS
 * API, no browser, no LLM tokens. It is CONSERVATIVE by design; anything
 * ambiguous (unknown ATS, 429/5xx, redirect, timeout) comes back `null`, which
 * we surface as "unknown" so a real job is never hidden by a flaky endpoint.
 *
 * Runs in a spawned subprocess for the same reason as the pipeline writer: Next's
 * bundler statically traces core `.mjs` paths that appear as import literals and
 * fails the production build.
 */

export type LivenessState = "active" | "expired" | "unknown";

export type LivenessVerdict = {
  url: string;
  state: LivenessState;
  /** provider code from the core checker, e.g. "lever_api_gone" (absent when unknown) */
  code?: string;
};

/** Bound the work a single request can commission — this is an open POST body. */
const MAX_URLS = 40;

export function checkLiveness(urls: string[]): Promise<LivenessVerdict[]> {
  const clean = Array.from(new Set(urls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)))).slice(0, MAX_URLS);
  if (clean.length === 0) return Promise.resolve([]);

  // Data-only / older checkout with no liveness-api.mjs → treat every candidate
  // as unknown rather than failing the hunt. Degrades to today's behaviour.
  if (!fs.existsSync(rootScript("liveness-api"))) {
    return Promise.resolve(clean.map((url) => ({ url, state: "unknown" as const })));
  }

  const apiUrl = pathToFileURL(rootScript("liveness-api")).href;
  const code = `
import { checkLivenessViaApi } from ${JSON.stringify(apiUrl)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", async () => {
  try {
    const urls = JSON.parse(input);
    const out = await Promise.all(urls.map(async (url) => {
      try {
        const v = await checkLivenessViaApi(url);
        if (!v) return { url, state: "unknown" };
        return { url, state: v.result, code: v.code };
      } catch {
        return { url, state: "unknown" };
      }
    }));
    process.stdout.write(JSON.stringify(out));
  } catch {
    process.stdout.write("[]");
  }
});
`;

  return new Promise((resolve) => {
    const unknownAll = () => clean.map((url) => ({ url, state: "unknown" as const }));
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    // The core checker already caps each fetch at 8s; this only guards a wedged
    // child. On expiry we resolve "unknown" — never "expired".
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 30_000);
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(killer);
      resolve(unknownAll());
    });
    child.on("close", () => {
      clearTimeout(killer);
      try {
        const parsed = JSON.parse(out.trim() || "[]") as LivenessVerdict[];
        if (!Array.isArray(parsed) || parsed.length === 0) return resolve(unknownAll());
        // Re-key so a short/garbled reply can never silently drop a candidate.
        const byUrl = new Map(parsed.map((v) => [v.url, v]));
        resolve(clean.map((url) => byUrl.get(url) ?? { url, state: "unknown" as const }));
      } catch {
        resolve(unknownAll());
      }
    });
    child.stdin.end(JSON.stringify(clean));
  });
}
