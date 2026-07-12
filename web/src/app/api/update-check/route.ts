import { execFile } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Orchestrates the core's own update check (update-system.mjs check) — the SAME
// source of truth CLAUDE.md tells the assistant to run at session start. We never
// reimplement the version comparison; we read the core's verdict and surface it
// as a banner so the user sees it without relying on the agent to speak up.
//
// The check hits GitHub (VERSION + releases API by hardcoded canonical URL, NOT
// a git remote — the origin/upstream rename does not affect it). Network-bound,
// so give it room but fail soft: any hiccup returns up-to-date-shaped silence.
export async function GET() {
  const root = careerOpsRoot();
  const updater = rootScript("update-system");
  // "unknown" = we could not run the check to a valid result. The banner renders
  // NOTHING for it — never a green "up to date" pill, which would be a false
  // all-clear. "up-to-date" is reserved for a check that actually succeeded.
  if (!fs.existsSync(updater)) {
    return Response.json({ status: "unknown" });
  }
  const stdout = await new Promise<string>((resolve) => {
    execFile("node", [updater, "check"], { cwd: root, timeout: 15_000 }, (_err, out) => resolve(out || ""));
  });
  try {
    // The checker prints one JSON object; take the last non-empty line to be safe
    // against any incidental leading output. No output → the check did not run.
    const last = stdout.trim().split("\n").filter(Boolean).pop();
    if (!last) return Response.json({ status: "unknown" });
    const j = JSON.parse(last) as { status?: string; local?: string; remote?: string; changelog?: string };
    if (j.status === "update-available") {
      return Response.json({
        status: "update-available",
        local: j.local ?? "",
        remote: j.remote ?? "",
        changelog: j.changelog ?? "",
      });
    }
    // up-to-date carries the version so the UI can show a "v1.18.0" pill;
    // dismissed / offline / no-remote-version stay silent (no version known). A
    // missing status is unknown, NOT up-to-date — don't fabricate an all-clear.
    return Response.json({ status: j.status ?? "unknown", local: j.local ?? "" });
  } catch {
    return Response.json({ status: "unknown" });
  }
}
