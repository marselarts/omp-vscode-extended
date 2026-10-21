import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { askContextPrompt } from "./askContext";
import { logError } from "./errorLog";
import { askInSideSession, type SideSessionHandle } from "./sideChat";
import type { TabManager } from "./tabManager";
import type { AskChatState, AskMessage } from "./types";

/**
 * Parallel "ask about this session" chat.
 *
 * Each question goes to a dedicated `omp --mode rpc` process fed the active
 * session's transcript. The live session's process is never prompted, so its turn
 * (and anything queued behind it) keeps running undisturbed.
 */
export class AskChat {
  /** Transcript for the session the questions refer to. */
  private sessionId: string | undefined;
  private title = "";
  private messages: AskMessage[] = [];
  private running: { id: string; handle: SideSessionHandle } | undefined;
  /** Set while a question is in flight and until it settles (success, error, stop). */
  private pendingId: string | undefined;
  private open = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly sessions: TabManager) {}

  getState(): AskChatState {
    return {
      open: this.open,
      sessionId: this.sessionId,
      title: this.title,
      busy: Boolean(this.running),
      messages: this.messages,
    };
  }

  async show(): Promise<void> {
    this.open = true;
    const tabId = this.sessions.getActiveId();
    const sessionId = this.sessions.getSessionIdForTab(tabId);
    if (sessionId !== this.sessionId) {
      // A different session: the old transcript no longer describes what is asked.
      this.sessionId = sessionId;
      this.messages = [];
      this.stop();
    }
    this.title = this.sessions.getTabTitle(tabId) ?? "New chat";
    this.notify();
  }

  /** Re-read the active tab's session and title, keeping the Q&A when it is the same session. */
  async refresh(): Promise<void> {
    const tabId = this.sessions.getActiveId();
    const sessionId = this.sessions.getSessionIdForTab(tabId);
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.messages = [];
      this.stop();
    }
    this.title = this.sessions.getTabTitle(tabId) ?? this.title;
    this.notify();
  }

  hide(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.stop();
    this.notify();
  }

  stop(): void {
    if (!this.pendingId) {
      return;
    }
    this.pendingId = undefined;
    this.running?.handle.abort();
    this.running = undefined;
    this.messages = this.messages.map((message) =>
      message.streaming ? { ...message, streaming: false, text: "Cancelled." } : message,
    );
    this.notify();
  }

  async ask(question: string): Promise<void> {
    const text = question.trim();
    if (!text || this.running) {
      return;
    }
    const tabId = this.sessions.getActiveId();
    const sessionId = this.sessions.getSessionIdForTab(tabId);
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.messages = [];
    }
    this.title = this.sessions.getTabTitle(tabId) ?? this.title;
    this.open = true;

    const user: AskMessage = { id: randomUUID(), role: "user", text, createdAt: Date.now() };
    const reply: AskMessage = {
      id: randomUUID(),
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      streaming: true,
    };
    this.messages = [...this.messages, user, reply];
    const replyId = reply.id;
    this.pendingId = replyId;
    const history = this.messages
      .slice(0, -2)
      .filter((message) => message.role === "user")
      .map((message, index, all) => ({
        question: message.text,
        answer: all[index + 1]?.role === "assistant" ? all[index + 1].text : undefined,
      }));
    this.notify();

    const patchReply = (update: (message: AskMessage) => AskMessage): void => {
      this.messages = this.messages.map((message) =>
        message.id === replyId ? update(message) : message,
      );
      this.notify();
    };

    try {
      const transcript = await this.sessions.getMessagesForTab(tabId);
      const cfg = vscode.workspace.getConfiguration("ompTimer");
      const model = cfg.get<string>("askModel", "").trim() || cfg.get<string>("model", "").trim();
      const handle = await askInSideSession(
        {
          cwd: this.sessions.getWorkspaceCwdPath(),
          ompPath: cfg.get<string>("ompPath", "omp") || "omp",
          model: model || undefined,
          extraArgs: cfg.get<string[]>("extraArgs", []),
        },
        askContextPrompt(this.title, transcript ?? [], history),
        text,
      );
      this.running = { id: replyId, handle };
      this.notify();
      if (this.pendingId !== replyId) {
        handle.abort();
        return;
      }
      patchReply((message) => ({ ...message, text: handle.text, streaming: false }));
    } catch (err) {
      const cancelled = this.pendingId === undefined || this.pendingId !== replyId;
      const detail = err instanceof Error ? err.message : String(err);
      if (!cancelled) {
        logError("Ask about session failed", err);
      }
      patchReply((message) => ({
        ...message,
        text: cancelled ? "Cancelled." : detail,
        streaming: false,
        error: !cancelled,
      }));
    } finally {
      if (this.pendingId === replyId) {
        this.pendingId = undefined;
      }
      this.running = undefined;
      this.notify();
    }
  }

  /** Drop state that refers to the session being restarted. */
  reset(): void {
    this.stop();
    if (this.messages.length) {
      this.messages = [];
    }
    this.notify();
  }

  dispose(): void {
    this.running?.handle.abort();
    this._onDidChange.dispose();
  }

  private notify(): void {
    this._onDidChange.fire();
  }
}
