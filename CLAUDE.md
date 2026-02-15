# Remote Claude

Monitor and control Claude Code sessions remotely via a mobile web dashboard.

## Project Structure
- `server/` -- Node.js + TypeScript server (HTTP + WebSocket)
- `hooks/` -- Claude Code hook script (bash + jq)
- `frontend/` -- React + Vite mobile web UI (built to `public/`)
- `public/` -- Built frontend assets (served as static files)
- `shared/` -- Shared TypeScript types and config constants
- `docs/` -- Architecture, design, event pipeline, roadmap

## Commands
- `npm run dev` -- Start server with hot reload (tsx watch)
- `npm run start` -- Start server (production)
- `npm run setup` -- Install hooks, rc CLI, and generate auth token
- `cd frontend && npm run build` -- Rebuild frontend after changes
- `rc off` -- Pause hooks and kill server (working locally)
- `rc on` -- Resume hooks (going remote)
- `rc` -- Show current status

## Terminology
- **Session** = a Claude Code instance (user-facing term in dashboard UI)
- **Tmux session** = the tmux concept. Always say "tmux session" to distinguish.
- `tmuxTarget` (e.g. `Personal:3.0`) = `tmuxSession:windowIndex.paneIndex`

## Debugging
- `RC_DEBUG=1 npm run start` -- Enable debug logging to console (always written to log file)
- `tail -f ~/.remote-claude/data/logs/server.log` -- Watch all logs including `[DBG]` lines
- `rc` script doesn't support env vars -- stop with `rc off`, start manually with `RC_DEBUG=1`
- Debug logs use `console.debug()` -- `[DBG]` prefix in log file, covers full event→session→topic flow
- Key debug prefixes: `[SessionManager]`, `[Topics]`, `[Telegram]`, `[Server]`

## Telegram Verification
Use Chrome browser tools to visually verify Telegram output after changes to formatting, topics, or notifications.
- Open `https://web.telegram.org/k/#TELEGRAM_CHAT_ID` (the negative group ID from env)
- Topic list in the left sidebar = session list. Click a topic to see its messages.
- Default/General topic: click "General" in the sidebar (used for system messages)
- Individual session topics: named after the session display name with status emoji prefix
- Verify: message formatting, status emojis in topic names, inline buttons (Approve/Reject), pinned status messages
- Topic URL format: `https://web.telegram.org/k/#CHAT_ID/THREAD_ID` to jump to a specific topic

## Parallel Agent Notes
- Re-read files before editing (another agent may have changed them)
- After editing `frontend/` files, rebuild: `cd frontend && npm run build`

## Remote Status Markers

At the END of every response, include exactly ONE status marker as the LAST LINE.

Format: `<!--rc:CATEGORY:message-->`

Categories:
- `question` -- You need user input or a decision
- `error` -- Something failed that needs attention
- `finished` -- Task complete, you are idle
- `summary` -- Brief summary of what you just did
- `progress` -- Milestone during a long task
- `silent` -- Nothing worth announcing

Rules:
1. EXACTLY ONE marker per response, as the LAST LINE
2. Keep message under 200 characters
3. Summarize for someone who cannot see your terminal
4. No code or file paths in the marker text
