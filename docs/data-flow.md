# Data flow

Two directions, one rule: the host is authoritative, the webview mirrors.

## Host → webview (`HostToWebview`, `src/omp/types.ts`)

| Message | Sent by | Consumer in `chat.js` |
|---|---|---|
| `ready` | `postState()` on every `TabManager.onDidChange`, tab switch, restart | replaces `state` wholesale, then `render()` |
| `status` | `SessionManager.onDidChange` for the active tab | `state.status = msg.status`, then `render()` |
| `messages` | incremental transcript pushes | replaces `state.messages`, then `render()` |
| `tabs` | tab strip refresh | `state.tabs`, `state.activeTabId` |
| `config` | settings changed (`showThinking`, `model`, `mode`, `displayName`) | merges into `state` |
| `contextUsage` | post-turn `get_state` | meter only (`updateChrome()`) |
| `attachments` | composer changes | chips |
| `uiQuestion` | `extension_ui_request` / answer | question card |
| `composerPrefill`, `inlineImage`, `fileResults` | menus, paste, `@` search | composer |
| `error` | any host exception in `onMessage`, failed session start | `state.status = {state:"error"}` |

`ready` carries the full snapshot: `status`, `messages`, `attachments`, `showThinking`, `model`,
`mode`, `displayName`, `contextUsage`, `tabs`, `activeTabId`, `uiQuestion`. Anything new that must
survive a webview reload belongs in `postState()`, not in a one-off delta.

## Webview → host (`WebviewToHost`)

`ready` (on load), `send`, `stop`, `newChat`, `switchTab`, `closeTab`, `tabContextMenu`, `restart`,
`history`, `moreMenu`, `pickModel`, `pickMode`, `showUsage`, `attachMenu`, `attachFiles`,
`attachFolder`, `attachTerminal`, `attachPaths`, `attachImage`, `attachTextFile`,
`removeAttachment`, `recallQueued`, `removeQueued`, `copy`, `insert`, `openExternal`,
`searchFiles`, `runSlashCommand`, `answerUiQuestion`, `openFile`.

Routing: `ChatViewProvider.onMessage()` switches on `msg.type`; unknown types are ignored. Every
handler exception is caught and surfaced as `{type:"error"}` (never thrown back into the webview).

## omp → host (`OmpRpcEvent`, `SessionManager.handleEvent`)

| Event | Effect |
|---|---|
| `agent_start`, `turn_start` | status `busy` + `beginTurn()` |
| `message_start` (assistant) | clears `currentAssistantId`, `ensureAssistantMessage()` — a retry starts a new bubble |
| `message_update` | `applyAssistantSnapshot` (streaming partial) or `handleAssistantEvent` (thinking/tool deltas) |
| `message_end` | final snapshot, closes thinking, `applyAssistantTimingMeta` (ttft/duration) |
| `agent_end` | `markTurnComplete()` → `endTurn()` |
| `tool_execution_start/update/end` | `upsertTool()` — one card per tool call id |
| `extension_ui_request` | `handleExtensionUiRequest()` → `uiQuestion` card + optional timeout |
| `prompt_error`, `error` | `system` message + status `error` |
| `auto_retry_start` | `noteAutoRetry()` → status stays `busy`, detail `Retrying (1/3) in 4s · reason` (clock untouched) |
| `prompt_result` with `agentInvoked === false` | `markTurnComplete()` — nothing ran, so the session must not stay busy |
| `setStatus` extension method | merges `detail` into the current status |

## Adding a field end-to-end

1. Type it in `src/omp/types.ts` (`SessionStatus`, `ChatMessage`, or the union member).
2. Populate it in `SessionManager`; if it must survive status churn, merge it in `setStatus()`.
3. Ship it: `postState()` for snapshot fields, a delta for per-turn fields.
4. Consume it in `chat.js` in the matching `msg.type` branch, then in `render()`/`updateChrome()`.
5. If it changes the rendered HTML of a streaming message, include it in `partsSignature()` or the
   in-place patcher will not notice.
6. Update `README.md` (feature + settings) and the relevant doc in this folder.

## Ordering guarantees worth knowing

- `TabManager.notify()` fires on every session change, including inactive tabs — the provider
  decides what to post, so new posts should stay tab-scoped.
- `markTurnComplete()` can run twice for one turn (omp `agent_end` plus the abort fallback timer);
  the second call returns early because the status already left `busy`.
- `hydrateMessagesFromSession()` is skipped when local messages exist, so a live transcript is never
  clobbered by a disk read.
