# Conventions

## Language and naming

- TypeScript in `src/`, plain ES2017-ish JS in `media/`, no build step for the webview.
- Types live in `src/omp/types.ts`. A function that returns a value with a shape consumers depend on
  exports a **named** type there; never publish `ReturnType<typeof fn>` or
  `Awaited<ReturnType<…>>` as a contract (e.g. `TimerHandle`, `ChatMessage[]`, `OmpHistorySession`).
- Extension-side identifiers are `ompChatExt.*`: command ids, setting keys, `getConfiguration("ompChatExt")`,
  view type `ompChatExt.sidebar`, storage keys `ompChatExt.openSessions` / `ompChatExt.lastSessionId`.
  Adding `ompChat.*` anywhere is a bug — that namespace belongs to `oh-my-pi-chat`.

## Host code

- `SessionManager` is the only place that mutates transcript/status. Route new behaviour through
  `setStatus()`, `patchMessage()`, `updateAssistant()`, `notify()`.
- Timers are typed `TimerHandle` and always cleared on dispose/restart; prefer one coalescing timer
  over many.
- Every webview command handler catches and reports; an exception must never escape `onMessage()`.
- Async work triggered from events goes through `void promise.catch(...)` with a logged reason.

## Webview code

- `state` is a plain object mirror. Never mutate host-owned fields directly; wait for the host.
- Build HTML with template strings plus `escapeHtml()`; new user-visible text must be escaped.
- Full `render()` is the default. Only the streaming message is patched in place, keyed by
  `partsSignature()` — extend the signature when a new part type or a message-level block changes.
- Collapse state is per `data-collapse-id` and persists in memory (`collapseOpenIds`).
- Tick loops live in `setInterval` guarded by a function that stops itself when the condition ends
  (`syncThinkingTimer`, `syncAgentClockTimer`). No interval may outlive its UI.

## Build and checks

```bash
npm install
npm run compile   # tsc --noEmit
npm run build     # esbuild -> dist/extension.js
npm run lint      # biome check .
npm run package   # vsce package -> omp-chat-extended-<version>.vsix
```

`npm run lint` on this fork still reports inherited findings from upstream
(`noControlCharactersInRegex` in `terminalCapture.ts`, `noDescendingSpecificity` in `chat.css`,
`useOptionalChain` in a few untouched functions, one `noImportantStyles`). Do not treat them as
regressions; do not fix them silently in an unrelated change. Formatting is biome-managed — run
`npx biome format --write <files>` rather than hand-formatting.

## Webview smoke test (no VS Code required)

```bash
mkdir .smoke && node -e "…build index.html from getHtml() + chat.css + chat.js with a stub acquireVsCodeApi…"
```

Then open `.smoke/index.html` in a browser tab and `postMessage` a `ready` payload. This is how the
timer was verified without launching the host: busy status with `turnStartedAt` must paint yellow +
a ticking clock; a `ready` status with `lastTurnMs` must paint green → grey and render the runtime
under the assistant message. Delete `.smoke/` afterwards.

## Commits

Repository format is `type: description` (`feat:`, `fix:`, `chore:`, `docs:`), matching the
upstream history. Reference the affected area in the body; one intentional commit per change.

## Docs

`docs/README.md` is the map. When behaviour changes, update the affected doc in the same commit:
`architecture.md` (structure), `agent-timer.md` (timing), `data-flow.md` (messages/events).
Feature-level notes for users belong in `README.md`, not here.
