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
