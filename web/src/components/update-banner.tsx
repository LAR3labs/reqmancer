"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpCircle, X, Settings, Check } from "lucide-react";

type UpdateInfo = { status: string; local?: string; remote?: string; changelog?: string };

function hasCli(): boolean {
  try {
    return !!JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId;
  } catch {
    return false;
  }
}

// The key persists a per-version dismissal so a dismissed banner does NOT re-nag
// for the SAME release, but DOES return when a newer version ships.
const DISMISS_KEY = "career-ops:update-dismissed";

// Surfaces the core updater's verdict (update-system.mjs check) as a banner, so
// the user learns about a new version from the UI instead of relying on the
// assistant to mention it. Applying still goes through the assistant (which runs
// `update-system.mjs apply` with confirmation) — the web never mutates system
// files on its own.
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [cli, setCli] = useState(true); // assume until read (avoid CTA flash)

  useEffect(() => {
    setCli(hasCli());
    fetch("/api/update-check")
      .then((r) => r.json())
      .then((d: UpdateInfo) => {
        // up-to-date is kept (drives the green pill); update-available respects a
        // prior dismissal of THIS remote version; everything else stays silent.
        if (d.status === "update-available") {
          try {
            if (localStorage.getItem(DISMISS_KEY) === d.remote) return;
          } catch {
            /* localStorage unavailable → show it */
          }
        } else if (d.status !== "up-to-date") {
          return;
        }
        setInfo(d);
      })
      .catch(() => {});
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      if (info?.remote) localStorage.setItem(DISMISS_KEY, info.remote);
    } catch {
      /* best-effort */
    }
  };

  if (!info) return null;

  // Up to date: a small, unobtrusive green pill — reassurance without a banner.
  if (info.status === "up-to-date") {
    return (
      <div className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="size-3.5" />
        Up to date{info.local ? <span className="tabular-nums opacity-70">· v{info.local}</span> : null}
      </div>
    );
  }

  if (dismissed) return null;

  const kickoff =
    `career-ops has an update available (v${info.local} → v${info.remote}). Please run \`node update-system.mjs apply\` to update the system files. My data (CV, profile, tracker, reports) must not be touched.`;

  return (
    <div className="dot-bg relative mb-6 overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/10 via-surface/40 to-transparent p-5">
      <button
        onClick={dismiss}
        className="absolute right-3 top-3 text-faint transition-colors hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="size-4" />
      </button>
      <h2 className="flex items-center gap-2 font-display text-xl text-landing">
        <ArrowUpCircle className="size-5 text-brand" /> Update available
      </h2>
      <p className="mt-1.5 max-w-xl text-sm text-muted">
        career-ops <span className="tabular-nums text-foreground">v{info.local}</span> →{" "}
        <span className="tabular-nums text-foreground">v{info.remote}</span>. Your data — CV, profile, tracker,
        reports — <span className="text-foreground">will not be touched</span>; only system files update.
      </p>
      {info.changelog && (
        <p className="mt-2 max-w-xl overflow-hidden text-xs text-faint" style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
          {info.changelog}
        </p>
      )}
      {cli ? (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("co-assistant", { detail: { message: kickoff } }))}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
        >
          <ArrowUpCircle className="size-4" /> Update with the assistant
        </button>
      ) : (
        // The assistant runs the update; without a CLI, send them to connect one.
        <Link
          href="/config"
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
        >
          <Settings className="size-4" /> Connect your AI CLI to update
        </Link>
      )}
    </div>
  );
}
