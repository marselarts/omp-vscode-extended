# Docs index

Orientation notes for working on **OMP Chat Timer** (`chakyiuli.omp-chat-timer`).
Read the file that matches your task; the map below is the starting point, not a substitute.

| File | Use when |
|---|---|
| [architecture.md](architecture.md) | You need the process/bridge shape: host ↔ webview ↔ `omp` RPC, who owns state |
| [agent-timer.md](agent-timer.md) | You touch turn timing, the header clock, or the traffic light |
| [data-flow.md](data-flow.md) | You add a message type, a status field, or a new event from `omp` |
| [conventions.md](conventions.md) | You are about to edit code, docs, or commit |

## The 60-second version

- `src/extension.ts` — `activate()`, commands, open-tab persistence.
- `src/omp/tabManager.ts` — one `SessionManager` per chat tab; the rest of the host talks to tabs, never to sessions directly.
- `src/omp/sessionManager.ts` (1754 lines, the centre of gravity) — owns transcript, status, attachments, queued prompts, UI questions, and **turn timing**.
- `src/omp/rpcClient.ts` — spawns `omp --mode rpc`, newline-delimited JSON over stdin/stdout.
- `src/chat/chatViewProvider.ts` — webview host: HTML shell, `HostToWebview`/`WebviewToHost` switchboard, pickers and menus.
- `media/chat.js` (3690 lines) + `media/chat.css` — the entire UI: rendering, markdown, collapse blocks, timer.

Rule of thumb: **timing and truth live in the host**; the webview renders and only counts time differences.

## Where things break first

- Session looks stuck busy → `markTurnComplete` / `abort` path in `sessionManager.ts`, then `agent_end` handling in `handleEvent`.
- Clock shows nothing → `turnStartedAt` must be set by `dispatchPrompt`; if the host restart dropped it, status arrives as `ready` with `lastTurnMs` only.
- Webview shows stale transcript → `postState` vs. incremental `messages` pushes; `partsSignature` decides remount.
- Two extensions fight in the command palette → command ids must stay `ompTimer.*` (never `ompChat.*`).
