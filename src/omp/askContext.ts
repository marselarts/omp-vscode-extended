import type { ChatMessage } from "./types";

/** Transcript characters that fit comfortably in one prompt; oldest turns drop first. */
const TRANSCRIPT_BUDGET = 24_000;
/** Per-block caps: previews are for orientation, not for replaying a tool. */
const THINKING_LIMIT = 1_200;
const INPUT_LIMIT = 400;
const OUTPUT_LIMIT = 800;

const ROLE_LABEL = { user: "User", assistant: "Assistant", system: "System" } as const;

function messageText(message: ChatMessage): string {
  const blocks: string[] = [];
  for (const part of message.parts) {
    if (part.kind === "text") {
      if (part.text.trim()) blocks.push(part.text.trim());
      continue;
    }
    if (part.kind === "thinking") {
      // An unfinished thinking step is mid-thought and says nothing yet.
      if (part.streaming) continue;
      const body = part.text.trim();
      if (body) blocks.push(`(thinking) ${body.slice(0, THINKING_LIMIT)}`);
      continue;
    }
    const files = part.fileRefs?.map((ref) => ref.path) ?? part.filePaths ?? [];
    const lines = [`[tool ${part.name}${part.status === "done" ? "" : `: ${part.status}`}]`];
    if (files.length) lines.push(`files: ${files.join(", ")}`);
    if (part.inputPreview?.trim())
      lines.push(`in: ${part.inputPreview.trim().slice(0, INPUT_LIMIT)}`);
    if (part.outputPreview?.trim()) {
      lines.push(`out: ${part.outputPreview.trim().slice(0, OUTPUT_LIMIT)}`);
    }
    blocks.push(lines.join("\n"));
  }
  const attachments = message.attachments?.map((item) => item.path || item.fsPath || item.label);
  if (attachments?.length) {
    blocks.push(`attachments: ${attachments.join(", ")}`);
  }
  return blocks.join("\n\n");
}

/** Compact plain-text view of the session, oldest turns dropped past the budget. */
export function transcriptForAsk(messages: ChatMessage[]): string {
  const blocks = messages
    .filter((message) => !message.queued)
    .map((message) => {
      const body = messageText(message);
      if (!body) {
        return "";
      }
      const stamp = new Date(message.createdAt).toISOString().slice(11, 19);
      return `### ${ROLE_LABEL[message.role]} ${stamp}\n${body}`;
    })
    .filter(Boolean);

  let kept = blocks;
  let text = kept.join("\n\n");
  while (text.length > TRANSCRIPT_BUDGET && kept.length > 1) {
    kept = kept.slice(1);
    text = kept.join("\n\n");
  }
  return text.slice(-TRANSCRIPT_BUDGET);
}

/**
 * System prompt for the side session: its only view of the chat. The question
 * itself is the side session's prompt, so askers append their own framing.
 */
export function askContextPrompt(
  title: string | undefined,
  messages: ChatMessage[],
  history: Array<{ question: string; answer?: string }>,
): string {
  const lines = [
    "You answer questions about a coding-agent session that is running in another process right now.",
    "You are a read-only side channel: no tools, no edits, no commands, and nothing you say reaches that agent.",
    "Answer only from the material below. If it does not contain the answer, say what is missing instead of guessing.",
    "Be concise and concrete: name the files, commands, tools, and states that appear in it.",
    "",
    `Session title: ${title?.trim() || "untitled"}`,
    "Transcript (oldest first; very long sessions are tail-clipped):",
    transcriptForAsk(messages) || "(the session has no messages yet)",
  ];
  if (history.length) {
    const asked = history
      .map((item) => `Q: ${item.question}\nA: ${item.answer ?? "(no answer)"}`)
      .join("\n\n");
    lines.push("", "Earlier questions asked in this side chat:", asked);
  }
  return lines.join("\n");
}
