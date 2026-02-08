# Remote Claude

Monitor and control Claude Code sessions remotely via a mobile web dashboard.

## Project Structure
- `server/` -- Node.js + TypeScript server (HTTP + WebSocket)
- `hooks/` -- Claude Code hook script (bash + jq)
- `frontend/` -- React + Vite mobile web UI (built to `public/`)
- `public/` -- Built frontend assets (served as static files)
- `shared/` -- Shared TypeScript types and config constants
- `bin/` -- CLI setup tool
- `docs/` -- Architecture, design, and roadmap
- `docs/archive/` -- Pre-implementation planning docs (historical)

## Key Files
- `server/index.ts` -- HTTP routes, WebSocket, static serving
- `server/SessionManager.ts` -- Session lifecycle, auto-discovery, health checks
- `server/EventProcessor.ts` -- Event ingestion, dedup, JSONL file watching
- `server/TmuxController.ts` -- Safe tmux wrappers (load-buffer/paste-buffer, send-keys)
- `server/MarkerParser.ts` -- rc marker regex parser
- `server/PushManager.ts` -- Web Push subscription management and delivery
- `hooks/remote-claude-hook.sh` -- Reads hook JSON from stdin, posts events to server
- `frontend/src/App.tsx` -- Main React app component
- `frontend/src/components/` -- React UI components (SessionCard, InputArea, PermissionPrompt, etc.)
- `public/index.html` -- Built dashboard entry point
- `shared/types.ts` -- ManagedSession, ClaudeEvent, RcMarker, WS protocol types
- `shared/defaults.ts` -- Port (4080), data dir, timeouts, intervals

## Commands
- `npm run dev` -- Start server with hot reload (tsx watch)
- `npm run start` -- Start server (production)
- `npm run setup` -- Install hooks into Claude Code settings

## How It Works
1. Claude Code hooks fire on every event (tool use, stop, notification, etc.)
2. Hook script reads JSON from stdin, extracts event data + tmux pane target
3. Hook appends to `~/.remote-claude/data/events.jsonl` + POSTs to server
4. Server auto-discovers sessions from hook events (no manual session creation needed)
5. Server broadcasts events via WebSocket to connected dashboards
6. Dashboard shows session cards, event feeds, and prompt input
7. Prompts sent via dashboard are delivered to the correct tmux pane
8. Permission prompts can be approved/rejected from the dashboard via tmux keys
9. Prompts sent while a session is busy are queued and auto-sent when it becomes idle

## Terminology
- **Session** = a Claude Code instance. This is the user-facing term in the dashboard UI.
- **Tmux session** = the tmux concept (contains windows and panes). Always say "tmux session" to distinguish.
- Server-created sessions run as **windows** in the shared `remote-claude` tmux session.
- Auto-discovered sessions run in whatever tmux session/window/pane the user launched them in.
- `tmuxTarget` (e.g. `Personal:3.0`) = `tmuxSession:windowIndex.paneIndex` -- the full tmux address.

## Architecture Decisions
- Sessions are auto-discovered from hook events, not from tmux session listing
- Each event includes `tmuxTarget` (e.g. `Personal:3.0`) for precise pane targeting
- No `rc-` prefix convention -- works with any existing tmux setup
- Manually created sessions share a single `remote-claude` tmux session with named windows
- Web Push API for reliable mobile notifications — server pushes directly to service worker via Google push servers, bypassing WebSocket (Android kills WS when tab is backgrounded)
- Service worker (`frontend/public/sw.js`, built to `public/sw.js`) handles push events and notification clicks
- VAPID keys and push subscriptions persisted in `~/.remote-claude/data/`
- SW push handler skips notification when a page client is visible (avoids duplicates with client-side notifications)
- Client-side notifications still fire when page is active (instant, no external dependency)
- Notification modes cycle: off → silent → vibrate → full (persisted in localStorage)
- Toggling notifications on subscribes to push; toggling off unsubscribes
- Long-press bell icon to fire a test notification
- Frontend is now a React/Vite app in `frontend/` (replaces old single-file HTML)
- `public/index.html` is a built artifact from the React frontend
- Prompt queue: when a session is working, new prompts are queued client-side and auto-sent on idle
- Create session modal has checkbox toggles for common flags (--dangerously-skip-permissions, --chrome)
- Permission request data falls back to preceding pre_tool_use event when notification lacks tool info

## Parallel Agent Notes
- When multiple agents edit this codebase, re-read files before editing (another agent may have changed them)
- After editing `frontend/` files, rebuild: `cd frontend && npm run build`
- Ephemeral coordination state lives in the memory directory, NOT here

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
