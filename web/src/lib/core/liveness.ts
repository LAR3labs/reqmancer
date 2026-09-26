import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

/**
 * Zero-token liveness and posting-date check for agent search candidates.
 *
 * The deterministic scan is live by construction — it reads the ATS API, so a
 * posting it returns exists. AI search inherits whatever the web index served,
 * and search indexes lag reality by days: a candidate can 404 the moment you
 * click it. Every AI offer was already stamped `verification: "unconfirmed"`,
 * but nothing ever acted on that flag.
 *
 * The ATS API handles known postings first. Playwright checks other pages and
 * reads JobPosting.datePosted when available. Only hard expiry signals hide a
 * candidate; a short page or failed check leaves it visible as unknown.
 *
 * Runs in a spawned subprocess for the same reason as the pipeline writer: Next's
 * bundler statically traces core `.mjs` paths that appear as import literals and
 * fails the production build.
 */

export type LivenessState = "active" | "expired" | "unknown";

export type LivenessVerdict = {
  url: string;
  state: LivenessState;
  code?: string;
  postedAt?: string;
};

/** Bound the work a single request can commission — this is an open POST body. */
const MAX_URLS = 40;
let browserQueue: Promise<void> = Promise.resolve();

export function checkLiveness(urls: string[]): Promise<LivenessVerdict[]> {
  const clean = Array.from(new Set(urls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)))).slice(0, MAX_URLS);
  if (clean.length === 0) return Promise.resolve([]);

  // Older checkouts can lack a checker module. Keep candidates visible.
  if (!["liveness-api", "liveness-browser", "browser-launch", "liveness-core"].every((name) => fs.existsSync(rootScript(name)))) {
    return Promise.resolve(clean.map((url) => ({ url, state: "unknown" as const })));
  }

  const apiUrl = pathToFileURL(rootScript("liveness-api")).href;
  const browserUrl = pathToFileURL(rootScript("liveness-browser")).href;
  const launchUrl = pathToFileURL(rootScript("browser-launch")).href;
  const coreUrl = pathToFileURL(rootScript("liveness-core")).href;
  const code = `
import { checkLivenessViaApi } from ${JSON.stringify(apiUrl)};
import { checkUrlLiveness, newLivenessPage } from ${JSON.stringify(browserUrl)};
import { launchStealthBrowser } from ${JSON.stringify(launchUrl)};
import { jobPostingDatePosted } from ${JSON.stringify(coreUrl)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", async () => {
  let browser;
  try {
    const urls = JSON.parse(input);
    const out = [];
    for (const url of urls) {
      let state = "unknown", code, postedAt;
      try {
        const api = await checkLivenessViaApi(url);
        if (api?.result === "expired") {
          out.push({ url, state: "expired", code: api.code });
          continue;
        }
        if (api?.result === "active") { state = "active"; code = api.code; postedAt = api.postedAt; }
        if (!browser) ({ browser } = await launchStealthBrowser());
        const page = await newLivenessPage(browser);
        try {
          const checked = await checkUrlLiveness(page, url);
          const hardExpiry = ["http_gone", "expired_url", "expired_body", "valid_through_passed"].includes(checked.code);
          if ((checked.result === "expired" && hardExpiry) || checked.result === "active") {
            state = checked.result;
            code = checked.code;
          }
          if (checked.result === "active") {
            const blocks = await page.evaluate(() =>
              [...document.querySelectorAll('script[type="application/ld+json"]')].map((el) => el.textContent || '')
            );
            postedAt = jobPostingDatePosted(blocks) || postedAt;
          }
        } finally {
          await page.close();
        }
      } catch { // A failed check cannot establish that a posting expired.
      }
      out.push({ url, state, code, postedAt });
    }
    process.stdout.write(JSON.stringify(out));
  } catch {
    process.stdout.write("[]");
  } finally {
    if (browser) await browser.close();
  }
});
`;

  const run = () => new Promise<LivenessVerdict[]>((resolve) => {
    const unknownAll = () => clean.map((url) => ({ url, state: "unknown" as const }));
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    // The browser rung can take longer than an ATS API call.
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 90_000);
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
  const result = browserQueue.then(run, run);
  browserQueue = result.then(() => {}, () => {});
  return result;
}
