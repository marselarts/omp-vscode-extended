# Agent runtime timer

The reason this fork exists. Three surfaces, one clock source.

| Surface | Where | Format |
|---|---|---|
| Live clock in the tab strip | `media/chat.js` `paintAgentClock()` | `0:07`, `1:23`, `12:05` (`formatTurnClock`) |
| Settled runtime under a finished assistant reply | `renderMessage()` → `turnRuntimeHtml()` | `7.4s`, `42s`, `1m 04s` (`formatTurnRuntime`) |
| Traffic light replacing the opaque status dot | `paintAgentLight()` | yellow / red / green / grey |

## Data contract

`src/omp/types.ts`:

```ts
interface SessionStatus {
  state: "starting" | "ready" | "busy" | "error" | "stopped";
  detail?: string;
  turnStartedAt?: number; // epoch ms; present only while a turn runs
  lastTurnMs?: number;    // runtime of the last finished turn
}

interface ChatMessage {
  // …
  durationMs?: number; // runtime of the turn that produced this assistant message
  endedAt?: number;
}
```

`turnStartedAt` is the whole protocol. The webview computes `Date.now() - turnStartedAt`; the host
never pushes tick updates.

## Host lifecycle (`src/omp/sessionManager.ts`)

| Transition | Code | Effect |
|---|---|---|
| Prompt dispatched | `dispatchPrompt()` → `beginTurn()` | `turnStartedAt = now`, status `busy` |
| omp confirms the turn | `handleEvent` `case "agent_start"` / `"turn_start"` → `beginTurn()` | covers resumed/background turns; resets a stale start |
| Turn settles | `markTurnComplete()` → `endTurn()` | records `durationMs` on the assistant message, `lastTurnMs` on status, drops `turnStartedAt` |
| Aborted turn settles | `finishAbortedTurn()` → `endTurn()` | same, so a stop still yields a duration |
| Stop pressed | `abort()` → `resetTurnClock()` | clock cleared immediately; no bogus runtime |
| New chat | `newChat()` | clock cleared, `lastTurnMs` reset |
| Status updates unrelated to turns | `setStatus()` | preserves `turnStartedAt`/`lastTurnMs` automatically |

`setStatus(status, { turnStartedAt })` is the only mutation point. Omitting the option keeps the
current clock, which is why `{ state: "busy", detail: "Retrying…" }`, UI-question details, and
`"Ready"` updates do not disturb timing.

`endTurn()` writes `durationMs` and `endedAt` onto the message **before** `markTurnComplete()`
patches thinking/tool parts, and both use `??=`, so a later snapshot cannot overwrite a measured
runtime (`applyAssistantTimingMeta` only touches thinking parts).

## Webview lifecycle (`media/chat.js`)

```
settleAgentClock()          called on ready / status / messages
  ├─ turnStartedAt present → syncAgentClockTimer()  → paintAgentClock(), start 250 ms interval
  └─ absent                → stop timer, flashAgentLight() if a turn was painted, paintAgentClock()
```

`agentClock` bookkeeping: `timer` (interval), `settleTimer` (green-flash timeout),
`flashUntil` (flash deadline), `paintedStart` (did we ever show a live clock → decide the flash).

- `paintAgentClock()` remounts the inner HTML only when switching `live`/`final` mode; otherwise it
  rewrites just `.turn-clock-value`, so the DOM is not rebuilt 4×/second.
- `header-clock[hidden]` is set by the `hidden` attribute, and CSS also hides it defensively.
- Final mode shows `status.lastTurnMs` in `m:ss`.

Light state is derived, never assigned:

```
error            → red
busy             → yellow
ready + flash    → green   (IDLE_FLASH_MS = 900)
otherwise        → grey
```

`#statusDot` is kept in the DOM for the tooltip and the UI-error path, but is hidden
(`statusDot.hidden = trafficLightEl != null`) so two indicators never compete.

## Formatting

```js
formatTurnClock(ms)    // floor to seconds: "0:07" | "3:20" | "12:05"
formatTurnRuntime(ms)  // <10s keeps a decimal: "7.4s"; else "42s" | "1m 04s"
```

`formatTurnRuntime` returns `""` for `0`/`NaN`, and `turnRuntimeHtml()` renders nothing in that
case — older messages without timing simply show no runtime line.

## Pitfalls

- **Clock stored in the host, not the webview.** Moving it into `chat.js` breaks tab switches and
  webview reloads (`retainContextWhenHidden` helps but is not enough).
- **Do not derive runtime from message timestamps** (`createdAt` is when the message object was
  created, not when the turn started).
- **Do not set `turnStartedAt` in `message_start`.** `message_start` fires on retries too and would
  silently reset a running clock; `beginTurn()` deliberately overwrites, so call it only at genuine
  turn boundaries.
- **`lastTurnMs` must survive idle status updates**, hence `setStatus` merges it; removing that
  merge makes the final clock disappear on the next `refreshSessionState`.
- The traffic light flashes on **transition**, driven by `settleAgentClock()` seeing a painted live
  clock disappear — not by `paintAgentLight()` observing green, which would re-flash on every idle
  repaint.

## Verifying a change

Webview-only check (no VS Code needed): rebuild the temp harness described in
`docs/conventions.md`, post `ready` with `status.turnStartedAt = Date.now() - 7400`, and confirm
yellow + `0:07`; then post `ready` with `state:"ready"`, `lastTurnMs`, and an assistant message
carrying `durationMs` and confirm green → grey plus the runtime line.
