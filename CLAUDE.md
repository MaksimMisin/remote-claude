# Remote Claude

Monitor and control Claude Code sessions remotely via a mobile web dashboard.

## Project Structure
- `server/` -- Node.js + TypeScript server (HTTP + WebSocket)
- `hooks/` -- Claude Code hook script (bash + jq)
- `public/` -- Single-file mobile web UI (plain HTML/CSS/JS, no build step)
- `shared/` -- Shared TypeScript types and config constants
- `bin/` -- CLI setup tool
- `docs/` -- Design and architecture documents

## Key Files
- `server/index.ts` -- HTTP routes, WebSocket, static serving
- `server/SessionManager.ts` -- Session lifecycle, auto-discovery, health checks
- `server/EventProcessor.ts` -- Event ingestion, dedup, JSONL file watching
- `server/TmuxController.ts` -- Safe tmux wrappers (load-buffer/paste-buffer)
- `server/MarkerParser.ts` -- rc marker regex parser
- `hooks/remote-claude-hook.sh` -- Reads hook JSON from stdin, posts events to server
- `public/index.html` -- Full dashboard UI with WebSocket, notifications, audio alerts
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

## Architecture Decisions
- Sessions are auto-discovered from hook events, not from tmux session listing
- Each event includes `tmuxTarget` (e.g. `Personal:3.0`) for precise pane targeting
- No `rc-` prefix convention -- works with any existing tmux setup
- Web Notifications API + Web Audio API for alerts (no service worker yet)
- Frontend is now a React/Vite app in `frontend/` (replaces old single-file HTML)
- `public/index.html` is a built artifact from the React frontend

## Parallel Agent Coordination

When multiple agents work on this codebase simultaneously, check this section first.

### Active work streams (update when you start/finish a task)
- **Context display on waiting sessions** (in progress): Adding `lastAssistantText` to `ManagedSession`, showing full context on session cards when session needs input. Touches: `shared/types.ts`, `server/SessionManager.ts`, `frontend/src/types.ts`, `frontend/src/components/SessionCard.tsx`, `frontend/src/App.css`
- **React frontend migration** (done): Moved from single-file HTML to React/Vite in `frontend/`
- **Hook improvements** (done): Extended assistantText to 500 chars, added pre_tool_use transcript extraction
- **Session creation UI** (done): Directory browsing, flags support, recent dirs

### Rules for agents
1. Before editing a file, re-read it — another agent may have changed it
2. After editing, rebuild frontend if you touched `frontend/`: `cd frontend && npm run build`
3. Update this section when you start or finish a task

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
