# Oh My Pi Chat

A VS Code extension that gives [Oh My Pi (`omp`)](https://omp.sh/) a **Copilot / Cursor-style chat sidebar**.

It launches a local `omp --mode rpc` session and streams replies, thinking, and tool activity into a modern webview chat UI.

Fork of [Chakyiu/omp-vscode](https://github.com/Chakyiu/omp-vscode) with **agent runtime timing**. It installs as a separate extension (`chakyiuli.omp-chat-timer`) next to `chakyiuli.oh-my-pi-chat`: different extension id, command ids (`ompTimer.*`) and settings namespace, so both can be installed and used side by side.

## Features

- **Agent runtime timer**
  - Live `m:ss` readout in the chat tab strip while a turn runs (`0:07`, `1:23`, `12:05`), yellow-tinted
  - Settled runtime under every finished assistant reply (`7.4s`, `1m 04s`)
  - Traffic-light status: **yellow** = agent running, **red** = needs you (error / wait), **green** = turn just finished, **grey** = idle
  - Timing comes from the extension host (`turn_start`/`prompt` → `agent_end`), so it survives webview reloads and tab switches

- Multi-tab chats (each tab is its own `omp` session)
- Agent-generated session titles on tabs (tiny/smol title model; disable with `ompTimer.autoTitle`)
- Right-click a chat tab to rename / view / export / copy the full session as plain text
- Restores all open omp chat tabs/sessions after VS Code restarts or force-quits
- History button lists all past omp sessions for the workspace and can resume any of them

- Model picker button (lists `omp models --json`, restarts session on change)
- Per-session context usage meter from omp `get_state.contextUsage`


- Activity-bar **Chat** sidebar (Copilot-like)
- Streaming assistant responses over omp RPC
- Collapsible **thinking** blocks
- Live **tool call** cards
- Attach current file / selection from the editor context menu
- New chat, stop generation, restart session
- Settings for model, thinking level, approval mode, auto-approve

## Prerequisites

1. Install Oh My Pi so `omp` is on your `PATH`
2. Configure provider auth the same way you do for the terminal CLI
3. VS Code `1.90+`

## Develop

```bash
npm install
npm run build
```

Then press **F5** (`Run Extension`) to open an Extension Development Host.

## Use

1. Open the **OMP** icon in the Activity Bar (the timer fork shows **OMP**; view title `OMP: Chat`)
2. Type a prompt and press **Enter**
3. Optional:
   - Right-click in the editor → **OMP: Attach Current File**
   - Select code → **OMP: Send Selection to Chat**
4. Use the view title buttons for **New Chat**, **Stop**, or **Restart Session**

### Keyboard shortcuts

| Action | macOS | Windows/Linux |
|---|---|---|
| Open chat | `Cmd+Shift+;` | `Ctrl+Shift+;` |
| Send selection | `Cmd+Shift+'` | `Ctrl+Shift+'` |

## Settings

| Setting | Meaning |
|---|---|
| `ompTimer.ompPath` | Path to `omp` (default: `omp`) |
| `ompTimer.model` | Model override (fuzzy match) |
| `ompTimer.thinking` | Thinking level |
| `ompTimer.approvalMode` | `always-ask` / `write` / `yolo` |
| `ompTimer.autoApprove` | Pass `--auto-approve` |
| `ompTimer.continueLastSession` | Restore all open omp chat tabs/sessions on start (default on; survives VS Code kills) |
| `ompTimer.autoTitle` | Let omp generate a short session title after the first message (default on; restart chats when toggling) |
| `ompTimer.extraArgs` | Extra CLI args |
| `ompTimer.showThinking` | Show/hide thinking blocks in UI |
| `ompTimer.logFileTouches` | Log edit/write/delete touched paths to **OMP File Touches** output channel |

Quick error log: Command Palette → **OMP: Show Error Log** (also in the chat ⋯ menu). Entries persist across reloads and auto-clear after 7 days.

## Architecture

```
VS Code extension host
  └─ ChatViewProvider (webview sidebar)
       └─ SessionManager
            └─ OmpRpcClient
                 └─ spawn: omp --mode rpc --cwd <workspace>
                      stdin/stdout: newline-delimited JSON
```

Prompt command:

```json
{ "type": "prompt", "message": "..." }
```

Stop command:

```json
{ "type": "abort" }
```

## Package

```bash
npm run package
```

This produces a `.vsix` you can install with:

```bash
code --install-extension omp-chat-timer-0.1.0.vsix
```

It coexists with `oh-my-pi-chat`; nothing of the original extension is overwritten.

## Notes / roadmap

- Interactive omp questions (`extension_ui_request`: confirm / select / input / editor) render above the composer
- Edit/write/delete file touches are logged to the **OMP File Touches** output channel (`OMP: Show File Touch Log`)
- Tool auto-approval still uses `approvalMode` / `autoApprove` (separate from question cards)
- Multi-workspace root picker and inline apply/diff are natural next steps
- ACP (`omp acp`) is an alternative transport; this extension uses native `--mode rpc` for richer streaming events


## Attachments

- Click **📎** / **Files** / **Folder** in the composer
- Type `@` in the composer to insert an inline file/folder mention
- Paste an image from the clipboard into the input (shows as an inline chip)
- Drag & drop files onto the chat panel
- Right-click in Explorer → **OMP: Attach to Chat**
- Attach recent terminal / CMD output via **📎 → Attach terminal output**, `/terminal`, `@terminal`, or the terminal context menu

Paperclip/drag attachments are sent to `omp` as `@/absolute/path` mentions (images/files/folders). `@` autocomplete inserts an inline `@path` mention in the prompt. Code selections and terminal command output are inlined as fenced blocks.

> Terminal capture uses VS Code **shell integration** (default for bash/zsh/pwsh/fish). Run a command in the integrated terminal first, then attach it.