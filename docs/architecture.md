# Architecture

## Layers

```
VS Code extension host (Node)
  extension.ts                 activate(), commands ompTimer.*, open-tab persistence
  └─ ChatViewProvider          webview lifecycle, HTML shell, message switchboard, pickers/menus
       └─ TabManager           tabs: id -> SessionManager, titles, active tab, restore state
            └─ SessionManager  transcript + status + attachments + queue + turn clock
                 └─ OmpRpcClient   spawn("omp", ["--mode","rpc", ...]), stdin/stdout NDJSON

Webview (untitled, CSP nonce)
  media/chat.js    state mirror + render(); talks only via postMessage
  media/chat.css   layout, markdown, collapse blocks, clock, traffic light
```

## Ownership rules

| State | Owner | Verified by |
|---|---|---|
| Turn start/duration, status, transcript, queue, attachments, UI questions | `SessionManager` | `onDidChange` → `TabManager.notify()` → `ChatViewProvider.postState()` / `post({type:"status"})` |
| Active tab, tab order, titles | `TabManager` | `getTabs()` in every `ready` push |
| Selection, scroll, composer text, collapse open/closed | webview only | never round-trips to the host |
| Turn timer display value | webview (derived) | `Date.now() - status.turnStartedAt` |

The webview never invents host state. It keeps a `state` mirror, replaces it on `ready`, and
applies deltas for `status`, `messages`, `tabs`, `config`, `contextUsage`.

## Extension host bootstrap

`src/extension.ts:46` `activate()`:

1. `initErrorLog`, `setTitleExtensionRoot`, `terminalCapture.start()`.
2. `TabManager(workspaceCwd, openSessionsStore)` — `workspaceState` keys `ompTimer.openSessions`
   and legacy `ompTimer.lastSessionId` (migrated on first write).
3. `ChatViewProvider(extensionUri, sessions, globalStorageUri)` registered for view type
   `ompTimer.sidebar`, `retainContextWhenHidden: true`.
4. Commands registered under `ompTimer.*`; contributed in `package.json` `contributes.commands`
   with titles `OMP Timer: …`, so nothing collides with `oh-my-pi-chat`.

## Tab lifecycle

`TabManager.createTab()` makes a `SessionManager` with a per-tab `SessionIdStore` bound to a
`Map` keyed by tab id, subscribes to `onDidChange` (bubbles only the active tab's UI state, plus
the tab strip), persists session ids, and activates.

- `switchTab` — changes `activeId`; lazily `ensureStarted()`.
- `closeTab` — disposes the session, drops title/session id, repersists.
- `newChat` — new tab, never reuses the old session.
- `openHistorySession` — resumes a past omp session id (subject to `continueLastSession`).
- `restartAll` — used when settings that require a fresh process change.

Title resolution order: manual rename → omp/agent session title → first user message.

## omp transport

`OmpRpcClient` spawns one process per session and speaks newline-delimited JSON:

| Direction | Shape |
|---|---|
| Host → omp | `{"type":"prompt","message":"…"}`, `{"type":"abort"}`, `{"type":"get_state"}`, `{"type":"get_messages"}`, `{"type":"extension_ui_response", …}` |
| omp → Host | `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `agent_end`, `tool_execution_*`, `extension_ui_request`, `prompt_error`, `error` |

`request()` adds a correlation id and a timeout; `send()` is fire-and-forget for prompt/abort.
`getState()` / `getMessages()` back the history hydration path
(`hydrateMessagesFromSession` → `sessionHistory.ts`).

## Webview

`ChatViewProvider.getHtml()` builds one document: tab strip, active question, message list,
empty state, composer, previews, suggestion list, queue panel. Ids consumed by `chat.js` at
top level: `messages`, `empty`, `trafficLight`, `turnClock`, `input`, `tabs`, `suggest*`,
`queue*`, `uiQuestion`, `activeQuestion`, `imagePreview*`, `usage*`, `statusDot`.

Rendering is a full `render()` pass with one optimisation: while the last message is streaming,
`partsSignature()` decides whether to remount it or patch thinking/text/tool nodes in place.
Scroll position is preserved across full re-renders unless the user is near the bottom.

## Failure surfaces

- `status.state` is the single source of truth for interactivity: `ready` and `busy` enable the
  composer, `starting`/`error`/`stopped` disable it (`render()` in `chat.js`).
- `abort()` sets a 500 ms fallback timer so a missing `agent_end` cannot leave the session busy.
- `markTurnComplete()` tolerates duplicate settles (returns early once not busy).
- `error`/`prompt_error` push a `system` message and set `status.state = "error"`.

## Parallel ask chat

`AskChat` (`src/omp/askChat.ts`) answers questions *about* the active session without
touching its process: omp rejects a second `prompt` while an agent is processing, so the
ask runs in its own throwaway process.

| Step | Where |
|---|---|
| Open / close / stop | `ChatViewProvider` ← `openAsk`, `closeAsk`, `stopAsk`; view-title `ompTimer.askAboutSession`, `/ask` |
| State owner | `AskChat` (`AskChatState` → webview `ask` message); `open`/`sessionId`/`busy`/`messages` |
| Transcript | `TabManager.getMessagesForTab(tabId)` → `transcriptForAsk` (tail-clipped, streaming thinking skipped) |
| Model call | `askInSideSession` (`src/omp/sideChat.ts`): `omp --mode rpc --no-session --no-tools --no-extensions`, prompt sent **after `ready`**, text deltas collected until `agent_end` |
| UI | `#askDialog` in the webview (`media/chat.js` `renderAsk`); the live transcript and composer are untouched |

Session switch or restart resets the ask chat (`ChatViewProvider` compares the active tab's
session id). The live session's status, timer, and queue are never modified by an ask.
