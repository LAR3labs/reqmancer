"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Telescope } from "lucide-react";
import { CostBadge } from "@/components/cost/cost-badge";

type Plan = { count: number; queries: string[]; hosts: string[] };

// Deep search has no input to fill in — the plan is the user's own curated
// `search_queries` from portals.yml. So the box's whole job is to SHOW the plan
// before any tokens are spent: how many searches, and which boards they reach
// that the free Scan can't. Cost honesty at the point of choice, same as the
// AI-search box, minus the guesswork.
export function DeepSearchBox({
  onSubmit,
  cliConfigured,
  cliName,
  onRunScan,
}: {
  onSubmit: () => void;
  cliConfigured: boolean;
  cliName?: string;
  onRunScan: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/explore/deep")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("plan unavailable"))))
      .then((d: Plan) => {
        if (live) setPlan(d);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const empty = plan?.count === 0;

  return (
    <div>
      <div className="rounded-xl border border-border bg-surface/40 p-4">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-brand">
          <Telescope className="size-3.5" /> Your saved searches — the boards no scanner can reach
        </div>

        {failed ? (
          <p className="text-[13px] text-muted">Couldn’t read your saved searches from portals.yml.</p>
        ) : !plan ? (
          <p className="text-[13px] text-faint">Reading your saved searches…</p>
        ) : empty ? (
          <p className="text-[13px] text-muted">
            No <code className="text-foreground">search_queries</code> configured in portals.yml — there’s nothing for Deep
            search to run yet.
          </p>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-muted">
              <span className="text-foreground">{plan.count}</span> saved {plan.count === 1 ? "search" : "searches"} from your
              portals.yml. These target boards that are bot-walled, auth-gated, or rendered in the browser — the free Scan
              cannot see them.
            </p>
            {plan.hosts.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {plan.hosts.map((h) => (
                  <span key={h} className="rounded-full border border-border bg-surface/60 px-2 py-0.5 text-[11px] text-muted">
                    {h}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            {cliConfigured ? (
              <>
                Runs them with <span className="text-foreground">{cliName || "your CLI"}</span> — it costs your tokens, but
                there’s no planning step, so it’s cheaper than AI search.
              </>
            ) : (
              "Connect an AI CLI in Config to use Deep search."
            )}
          </span>
          <button
            type="button"
            disabled={!cliConfigured || !plan || empty}
            onClick={onSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-sm transition hover:brightness-110 disabled:opacity-50"
          >
            Run {plan && !empty ? `${plan.count} ` : ""}saved {plan?.count === 1 ? "search" : "searches"}
            <CostBadge kind="spend" size="xs" />
            <ArrowRight className="size-4" />
          </button>
        </div>
      </div>

      {plan && !empty && (
        <ul className="mt-3 space-y-1">
          {plan.queries.map((q) => (
            <li key={q} className="flex items-start gap-2 text-[12px] text-faint">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-brand/50" />
              {q}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex">
        <button
          type="button"
          onClick={onRunScan}
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-faint transition hover:text-foreground"
        >
          or run the free Scan instead →
        </button>
      </div>
    </div>
  );
}
