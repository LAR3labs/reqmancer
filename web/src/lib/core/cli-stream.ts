import { spawn } from "node:child_process";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";

/**
 * Shared CLI streaming transport for the Explore agent surfaces (AI search and
 * Deep search). Extracted verbatim from api/explore/ai/route.ts so both routes
 * share ONE hardened implementation — in particular the WebKit heartbeat
 * (#1822/PR #18), which took two rounds to get right and must never drift
 * between callers.
 *
 * Contract: spawns the user's own CLI headless, forwards assistant TEXT deltas
 * to the response body, and structurally forbids persistence (Write/Edit/Bash
 * are disallowed). Candidates reach disk only when the user later ADDs one.
 */

export type CliStreamResult =
  | { kind: "response"; response: Response }
  | { kind: "error"; status: number; body: Record<string, unknown> };

export function streamCliPrompt({ prompt, cliId }: { prompt: string; cliId: string }): CliStreamResult {
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return { kind: "error", status: 404, body: { error: `CLI '${cliId}' not found on this machine` } };
  }
  const { spec, binPath } = resolved;

  const isClaude = cliId === "claude";
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
        "--allowedTools",
        "Read,WebFetch,WebSearch,Glob,Grep", // WebSearch ADDED vs the read-only assistant
        "--disallowedTools",
        "Bash,Write,Edit,NotebookEdit,Task", // proposer-not-writer, by construction
      ]
    : spec.args(prompt);

  const child = spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });

  const encoder = new TextEncoder();
  // `closed` + kill timer in the OUTER scope so cancel() can flip `closed` before
  // the child's late handlers run — otherwise they enqueue onto an already-closed
  // controller and throw an uncaught "Controller is already closed" (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      let lastSent = Date.now();
      killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 480_000);
      // Idempotent — must run on EVERY terminal path. In particular, when
      // safeEnqueue's catch marks the stream closed, safeClose()'s !closed
      // guard skips its body, which would otherwise leave the heartbeat
      // interval firing forever.
      const cleanupTimers = () => {
        if (killer) clearTimeout(killer);
        if (heartbeat) clearInterval(heartbeat);
      };
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
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
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

      // A failed run (429 usage limit, auth expiry, …) produces NO text deltas —
      // the CLI reports it as a synthetic final `result` with is_error. Hold the
      // text and surface it on close, or the user sees a misleading generic guess.
      let errorText = "";
      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;
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
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        if (/error|not found|denied|fatal/i.test(s)) {
          safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`);
        }
      });
      child.on("error", (e) => {
        safeEnqueue(`\n[error launching ${spec.name}: ${e.message}]`);
        safeClose();
      });
      child.on("close", () => {
        if (!emitted) {
          safeEnqueue(errorText ? `_(${spec.name}: ${errorText})_` : "_(no output — is the CLI authenticated?)_");
        }
        safeClose();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      if (heartbeat) clearInterval(heartbeat);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
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
