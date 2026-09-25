import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";
import { CAPS } from "@/lib/worker-capabilities.mjs";
import { scopeFrom } from "@/lib/claude-invocation.mjs";
import { fencingReport } from "@/lib/cli-fencing.mjs";
import { codexFencingSupported } from "@/lib/cli-fencing-probe.mjs";

/**
 * Shared CLI streaming transport for the Explore agent surfaces (AI search and
 * Deep search). Both routes share ONE hardened implementation — in particular
 * the WebKit heartbeat (#1822/PR #18), which took two rounds to get right and
 * must never drift between callers — plus upstream's permission fencing and
 * Codex isolation (#2185, #2361, #2507), ported here from
 * api/explore/ai/route.ts so the Deep search route gets them too.
 *
 * Contract: spawns the user's own CLI headless, forwards assistant TEXT deltas
 * to the response body, and structurally forbids persistence (write tools are
 * denied). Candidates reach disk only when the user later ADDs one.
 */

// Deny list DERIVED, never hand-written: every one of the six advisor argvs
// that spelled its own omitted MultiEdit, which --permission-mode acceptEdits
// then auto-approves (#2185, #2507).
const ADVISOR_SCOPE = scopeFrom("Read,WebFetch,WebSearch,Glob,Grep");

// Isolation and output flags added to the Codex exec argv — not permission, so
// not fencing's (#2507), but a Codex build missing one breaks the run just as
// thoroughly, so the capability gate below checks them too.
const CODEX_ISOLATION_FLAGS = ["--strict-config", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check"];
const CODEX_OUTPUT_FLAG = "--output-last-message";

export type CliStreamResult =
  | { kind: "response"; response: Response }
  | { kind: "error"; status: number; body: Record<string, unknown> };

export async function streamCliPrompt({ prompt, cliId }: { prompt: string; cliId: string }): Promise<CliStreamResult> {
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return { kind: "error", status: 404, body: { error: `CLI '${cliId}' not found on this machine` } };
  }
  const { spec, binPath } = resolved;

  const isClaude = cliId === "claude";
  const isCodex = cliId === "codex";

  if (isCodex && !(await codexFencingSupported(binPath, { alsoRequiresInExec: [...CODEX_ISOLATION_FLAGS, CODEX_OUTPUT_FLAG] }))) {
    return {
      kind: "error",
      status: 400,
      body: {
        code: "CODEX_UNSUPPORTED",
        error: "Codex CLI does not support the required read-only execution flags. Update Codex and try again.",
      },
    };
  }

  // The complete mode, memory and dedup context are embedded in `prompt`.
  // Codex runs in an empty temporary cwd and writes only its final assistant
  // response to a dedicated file. Its normal console transcript includes the
  // full prompt and must never be forwarded to the Web UI.
  let childCwd: string;
  if (isCodex) {
    try {
      childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-codex-"));
    } catch {
      return {
        kind: "error",
        status: 400,
        body: { code: "CODEX_TEMP_DIR_FAILED", error: "Could not create an isolated Codex workspace for this search." },
      };
    }
  } else {
    childCwd = careerOpsRoot();
  }
  const codexResultFile = isCodex ? path.join(childCwd, "final-response.txt") : undefined;

  const args = isClaude
    ? [
        "-p",
        prompt,
        // Pinned to a full model ID, not the `opus` alias: an alias re-points
        // itself when a new Opus ships, so a discovery run's cost and behaviour
        // would change under the user without a commit. Only the claude branch
        // sets a model at all — every other CLI uses its own default.
        "--model",
        "claude-opus-5",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        // --strict-mcp-config with no --mcp-config loads ZERO MCP servers, so the
        // tool lists here describe everything this agent can reach. Required for a
        // non-writing worker: without it a user MCP server could supply a write tool
        // the capability record forbids, and cli-fencing refuses to certify that (#2507).
        "--strict-mcp-config",
        "--allowedTools",
        ADVISOR_SCOPE.allowed,
        "--disallowedTools",
        ADVISOR_SCOPE.disallowed,
      ]
    : isCodex
      ? [
          // Isolation and output only. Approval policy, the sandbox and web
          // access come from fencing, which refuses this argv if it spells them.
          "exec",
          ...CODEX_ISOLATION_FLAGS,
          CODEX_OUTPUT_FLAG,
          codexResultFile!,
          prompt,
        ]
      : spec.args(prompt);

  // POSIX detached children become process-group leaders. Keeping stdio
  // piped means Node still tracks the Codex process normally.
  const useCodexProcessGroup = isCodex && process.platform !== "win32";

  // Declared BEFORE the spawn: fencing can refuse the argv, and the temporary
  // workspace already exists by then. Without this the refusal path would leak
  // one directory per rejected request.
  const cleanupChildCwd = () => {
    if (!isCodex) return;
    try {
      fs.rmSync(childCwd, { recursive: true, force: true });
    } catch {
      /* best-effort temporary-directory cleanup */
    }
  };

  // Proposer-not-writer: Read + WebFetch + WebSearch allowed, every write tool
  // denied. Web use is search-shaped, so `webSearchOnly` — that lets Codex keep
  // a genuine read-only sandbox.
  let child: ReturnType<typeof spawnHeadlessCli>;
  try {
    child = spawnHeadlessCli(
      binPath,
      args,
      { cwd: childCwd, env: process.env, detached: useCodexProcessGroup },
      { cliId, capabilities: CAPS.webSearchOnly },
    );
  } catch (e) {
    cleanupChildCwd();
    return { kind: "error", status: 500, body: { error: e instanceof Error ? e.message : "failed to start the CLI" } };
  }

  const encoder = new TextEncoder();
  // `closed` + timers in the OUTER scope so cancel() can flip `closed` before
  // the child's late handlers run — otherwise they enqueue onto an already-closed
  // controller and throw an uncaught "Controller is already closed" (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const isCodexProcessGroupAlive = () => {
    if (!useCodexProcessGroup || !child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // Idempotent — must run on EVERY terminal path. In particular, when
  // safeEnqueue's catch marks the stream closed, safeClose()'s !closed guard
  // skips its body, which would otherwise leave the heartbeat firing forever.
  const cleanupTimers = () => {
    if (killer) {
      clearTimeout(killer);
      killer = undefined;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    // If the group leader exited but a descendant ignored SIGTERM, retain the
    // SIGKILL fallback until the remaining process group is gone.
    if (forceKill && !isCodexProcessGroupAlive()) {
      clearTimeout(forceKill);
      forceKill = undefined;
    }
  };

  const signalChild = (signal: NodeJS.Signals): boolean => {
    if (useCodexProcessGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        /* group may already be gone; fall back to the direct child */
      }
    }
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  };

  const terminateChild = () => {
    const termSent = signalChild("SIGTERM");
    if (!isCodex || !termSent || forceKill) return;
    forceKill = setTimeout(() => {
      signalChild("SIGKILL");
      forceKill = undefined;
    }, 5_000);
    forceKill.unref?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      let codexStderr = "";
      let lastSent = Date.now();
      killer = setTimeout(() => {
        terminateChild();
      }, 480_000);
      const safeClose = () => {
        cleanupTimers();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      const safeEnqueue = (s: string): boolean => {
        if (closed || !s) return false;
        try {
          controller.enqueue(encoder.encode(s));
          lastSent = Date.now();
          return true;
        } catch {
          // Controller closed underneath us — stop, never crash. Nobody will
          // consume further output, so reap the child now instead of waiting
          // for the 480s killer (which cleanupTimers just cleared).
          closed = true;
          cleanupTimers();
          terminateChild();
          return false;
        }
      };
      const emit = (s: string) => {
        if (safeEnqueue(s)) emitted = true;
      };

      // WebKit (Safari / the desktop app's WKWebView) fails the whole fetch with
      // a generic "Load failed" if the RESPONSE stays silent too long: headers
      // don't flush until the first body byte, and NSURLSession's idle timeout
      // (~60s) then kills the request — which an agent run trips easily during
      // its opening web-search phase (stream-json events flow on stdout, but
      // only text deltas are forwarded). Flush a byte immediately and keep the
      // pipe warm whenever nothing has been SENT for a while. Whitespace-only
      // chunks are invisible to the client parser; gating on sent-idle keeps a
      // heartbeat from ever landing inside a split <<offer:…>> envelope (text
      // deltas mid-envelope reset the timer as they're forwarded).
      safeEnqueue("\n");
      heartbeat = setInterval(() => {
        if (!closed && Date.now() - lastSent >= 15_000) safeEnqueue("\n");
      }, 15_000);

      // Same honesty as /api/run: a runtime with no verified fencing mechanism
      // runs with its default access, and that must be visible rather than
      // inferred from which CLI happens to be selected (#2507).
      const fencing = fencingReport({ cliId, cliName: spec.name, capabilities: CAPS.webSearchOnly });
      if (fencing.notice) safeEnqueue(`⚠️ ${fencing.notice}\n\n`);

      // A failed run (429 usage limit, auth expiry, …) produces NO text deltas —
      // the CLI reports it as a synthetic final `result` with is_error. Hold the
      // text and surface it on close, or the user sees a misleading generic guess.
      let errorText = "";
      child.stdout?.on("data", (d: Buffer) => {
        if (closed) return;
        // Codex's authoritative response is read from codexResultFile after
        // process completion. Drain but do not forward its console transcript.
        if (isCodex) return;
        if (!isClaude) {
          emit(d.toString());
          return;
        }
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
              const text = obj.event.delta?.text;
              if (typeof text === "string") emit(text);
            } else if (obj.type === "result" && obj.is_error && typeof obj.result === "string") {
              errorText = obj.result;
            }
          } catch {
            /* partial / non-json line — skip */
          }
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString();
        if (isCodex) {
          // Normal Codex stderr contains session metadata and the complete
          // prompt. Retain only a bounded private diagnostic signal and never
          // stream it during a successful request.
          codexStderr = (codexStderr + s).slice(-16_000);
          return;
        }
        if (/error|not found|denied|fatal/i.test(s)) {
          safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`);
        }
      });
      child.on("error", (e: Error) => {
        safeEnqueue(`\n[error launching ${spec.name}: ${e.message}]`);
        cleanupChildCwd();
        safeClose();
      });
      child.on("close", (code: number | null) => {
        cleanupTimers();
        if (closed) {
          cleanupChildCwd();
          return;
        }

        if (isCodex) {
          let finalText = "";
          try {
            if (codexResultFile && fs.existsSync(codexResultFile)) {
              finalText = fs.readFileSync(codexResultFile, "utf8").trim();
            }
          } catch {
            /* handled below as missing final output */
          }
          if (finalText) {
            emit(finalText);
          } else if (code !== 0) {
            const diagnosticText = codexStderr.trim();
            const diagnosticsCaptured = diagnosticText.length > 0;
            if (diagnosticsCaptured) {
              const lowerDiagnostics = diagnosticText.toLowerCase();
              const diagnosticMarkers = ["error", "fatal", "failed", "denied", "not found", "invalid", "unsupported"].filter(
                (marker) => lowerDiagnostics.includes(marker),
              );
              // Codex stderr may contain the complete user prompt. Log only
              // bounded metadata and marker categories, never its contents.
              console.error("[Codex agent search exited without a final response]", {
                exitCode: code ?? "unknown",
                stderrBytes: Buffer.byteLength(diagnosticText, "utf8"),
                stderrLines: diagnosticText.split(/\r?\n/).length,
                diagnosticMarkers,
              });
            }
            safeEnqueue(
              `\n[Codex exited with code ${code ?? "unknown"}${diagnosticsCaptured ? "; diagnostic output captured" : ""}]\n`,
            );
          } else if (!emitted) {
            safeEnqueue("_(no final output from Codex)_");
          }
          cleanupChildCwd();
          safeClose();
          return;
        }

        if (!emitted) {
          safeEnqueue(errorText ? `_(${spec.name}: ${errorText})_` : "_(no output — is the CLI authenticated?)_");
        }
        safeClose();
      });
    },
    cancel() {
      closed = true;
      if (killer) {
        clearTimeout(killer);
        killer = undefined;
      }
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      terminateChild();
    },
  });

  return {
    kind: "response",
    response: new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    }),
  };
}
