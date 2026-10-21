import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as readline from "node:readline";
import type { TimerHandle } from "./types";

const START_TIMEOUT_MS = 30_000;
/** Silence after the first token before giving up; second calls on a cold provider can stall. */
const ANSWER_TIMEOUT_MS = 300_000;

export interface SideSessionOptions {
  cwd: string;
  ompPath: string;
  model?: string;
  extraArgs?: string[];
}

export interface SideSessionHandle {
  text: string;
  abort(): void;
}

/**
 * Ask a *separate* `omp --mode rpc` process, so a busy live session is never
 * touched. Needs no extension, session, or tools.
 *
 * The question is sent as one RPC `prompt` after `ready`, and the answer is read
 * from the streamed text deltas until `agent_end`. `--no-session` keeps the Q&A
 * out of history.
 */
export function askInSideSession(
  options: SideSessionOptions,
  systemPrompt: string,
  question: string,
): Promise<SideSessionHandle> {
  const args = [
    "--mode",
    "rpc",
    "--cwd",
    options.cwd,
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-title",
    "--append-system-prompt",
    systemPrompt,
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  const proc: ChildProcessWithoutNullStreams = spawn(options.ompPath, args, {
    cwd: options.cwd,
    env: { ...process.env, PI_NO_TITLE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let text = "";
  let stderrTail = "";
  let started = false;
  let settled = false;
  /** Writes the question once omp is ready; kept out of the listener callback. */
  const sendPrompt = () =>
    new Promise<void>((done) => {
      proc.stdin.write(
        `${JSON.stringify({ id: "ask", type: "prompt", message: question })}\n`,
        () => done(),
      );
    });
  let finish: (err?: Error) => void = () => undefined;
  const handle: SideSessionHandle = {
    text: "",
    abort: () => finish(new Error("Ask cancelled")),
  };

  return new Promise<SideSessionHandle>((resolve, reject) => {
    let startTimer: TimerHandle | undefined;
    let answerTimer: TimerHandle | undefined;
    finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      clearTimeout(answerTimer);
      proc.kill();
      if (err) {
        reject(err);
        return;
      }
      handle.text = text.trim();
      resolve(handle);
    };

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(event.type ?? "");
      if (!started && type === "ready") {
        // omp reads piped input as JSON commands, so a ready-gated prompt runs
        // reliably; a start-up positional prompt is silently dropped when the
        // transcript is large.
        started = true;
        void sendPrompt();
        return;
      }
      if (event.type === "message_update") {
        const assistant = (event.assistantMessageEvent ?? event.event) as
          | Record<string, unknown>
          | undefined;
        if (assistant?.type === "text_delta" && typeof assistant.delta === "string") {
          text += assistant.delta;
          clearTimeout(answerTimer);
          answerTimer = setTimeout(
            () => finish(new Error("Ask timed out waiting for the answer")),
            ANSWER_TIMEOUT_MS,
          );
        }
        return;
      }
      // prompt_result can arrive before the last deltas; agent_end is final.
      if (type === "agent_end") {
        finish(text.trim() ? undefined : new Error("Side session returned no text"));
        return;
      }
      if (type === "prompt_result" && event.status === "error") {
        finish(new Error(String(event.error ?? "Side session failed")));
        return;
      }
      if (type === "prompt_error" || type === "error") {
        const detail = String(event.error ?? event.message ?? "Side session error");
        finish(new Error(detail));
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
    });
    proc.on("error", (err) => finish(err));
    proc.on("exit", (code) => {
      if (settled) return;
      finish(
        new Error(
          `Side session exited (code ${code ?? "null"}) ${stderrTail.trim().split("\n").pop() ?? ""}`.trim(),
        ),
      );
    });

    startTimer = setTimeout(
      () => finish(new Error("Ask timed out starting omp")),
      START_TIMEOUT_MS,
    );
  });
}
