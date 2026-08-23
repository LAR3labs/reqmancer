"use client";

import { Compass, Sparkles, Telescope } from "lucide-react";
import { cn } from "@/lib/cn";
import { CostBadge } from "@/components/cost/cost-badge";
import type { ExploreMode } from "@/lib/explore";

// Cost honesty rendered at the POINT OF CHOICE, cheapest first: free
// deterministic Scan (default) → Deep search (runs the user's own curated
// portals.yml search_queries; token cost, but no planning step) → open-ended AI
// search. Both agent segments stay selectable with no CLI — selecting one reveals
// the blocked state (more discoverable than a dead tab).
const SEGMENTS: Array<{
  mode: ExploreMode;
  label: string;
  short: string;
  Icon: typeof Compass;
  cost: "free-network" | "spend";
  needsCli: boolean;
}> = [
  { mode: "scan", label: "Scan", short: "Scan", Icon: Compass, cost: "free-network", needsCli: false },
  { mode: "deep", label: "Deep search", short: "Deep", Icon: Telescope, cost: "spend", needsCli: true },
  { mode: "ai", label: "AI search", short: "AI", Icon: Sparkles, cost: "spend", needsCli: true },
];

export function ExploreModeToggle({
  mode,
  onChange,
  cliConfigured,
}: {
  mode: ExploreMode;
  onChange: (m: ExploreMode) => void;
  cliConfigured: boolean;
}) {
  return (
    <div className="flex w-full rounded-xl border border-border bg-surface/40 p-1 sm:inline-flex sm:w-auto">
      {SEGMENTS.map(({ mode: m, label, short, Icon, cost, needsCli }) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-2 text-sm transition-colors sm:flex-none sm:gap-2 sm:px-3 max-sm:min-h-[44px]",
            mode === m ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
          )}
        >
          <Icon className="size-4 shrink-0" />
          {/* Three segments no longer fit full labels on a phone. */}
          <span className="font-medium sm:hidden">{short}</span>
          <span className="hidden font-medium sm:inline">{label}</span>
          <span className="hidden sm:inline-flex">
            <CostBadge kind={cost} size="xs" />
          </span>
          {needsCli && !cliConfigured && <span className="hidden text-[10px] text-faint lg:inline">needs a CLI</span>}
        </button>
      ))}
    </div>
  );
}
