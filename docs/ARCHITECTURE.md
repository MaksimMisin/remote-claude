# Remote Claude -- Technical Architecture

**System for monitoring and controlling multiple Claude Code CLI sessions running in tmux from a mobile web browser.**

---

## 1. System Overview

### Data Flow

```
Claude Code (in tmux pane)
    |
    | Hook fires (stdin JSON: hook_event_name, session_id, cwd, tool_name, etc.)
    v
Hook Script (remote-claude-hook.sh)
    |
    | 1. Detects tmux pane via TMUX_PANE env var -> tmuxTarget (e.g. "Personal:3.0")
    | 2. Appends ClaudeEvent JSON to ~/.remote-claude/data/events.jsonl
    | 3. POSTs ClaudeEvent JSON to http://localhost:4080/event (backgrounded)
    v
Server (Node.js + TypeScript, port 4080)
    |
    | 1. EventProcessor deduplicates + stores event
    | 2. SessionManager auto-discovers session or updates existing
    | 3. Broadcasts via WebSocket to all connected clients
    | 4. Streams tool events to Telegram forum topics (batched per 3s)
    | 5. Sends status notifications (finished/waiting/offline) to topics
    v
Mobile Web Dashboard (React + Vite)       Telegram Forum Group
    |                                        |
    | Displays session cards, event feeds    | One topic per session
    | Sends prompts via HTTP API             | Tool events streamed in real-time
    | Web Push + audio alerts                | Permission approve/reject buttons
    v                                        | Pinned live-status in General topic
Server delivers prompt to tmux pane          | Send messages to deliver prompts
    via load-buffer/paste-buffer             v
```

### Key Design Decisions

1. **Hook-based event capture** -- Claude Code's hook system provides structured JSON events via stdin. No terminal scraping needed.

2. **Auto-discovery from hook events** -- Sessions appear automatically when any Claude Code instance fires a hook event. No manual session creation or `rc-` prefix convention needed. Works with any existing tmux setup.

3. **tmuxTarget for pane precision** -- Each hook event includes the exact tmux target (`session:window.pane`), allowing prompts to be delivered to the correct pane even when multiple Claude instances run in the same tmux session.

4. **Dual delivery** (file + HTTP) -- Hook writes to JSONL file AND posts to server. File provides crash recovery (server watches with chokidar); HTTP provides low-latency delivery. Server deduplicates via event IDs.

5. **React + Vite frontend** -- Component-based React app in `frontend/`, built to `public/` as static assets. Mobile-first dark theme with hooks-based state management.

6. **Web Push + Service Worker** -- Uses Web Push API (VAPID) for reliable background notifications on Android (WebSocket dies when tab is backgrounded). Service worker in `frontend/public/sw.js` handles push events and notification clicks. Client-side notifications still fire when page is active (instant, no external dependency). Four notification modes cycle: off -> silent -> vibrate -> full.

---

## 2. Hook Script

**File:** `hooks/remote-claude-hook.sh` (installed to `~/.remote-claude/hooks/`)

### Input
Claude Code passes JSON to stdin with fields:
- `hook_event_name` -- PreToolUse, PostToolUse, Stop, UserPromptSubmit, SessionStart, SessionEnd, Notification
- `session_id` -- Claude Code's internal session UUID
- `cwd` -- Working directory
- `tool_name`, `tool_input` -- For tool use events
- `transcript_path` -- For Stop events (path to conversation JSONL)

### Processing
1. Reads JSON from stdin with `jq`
2. Maps `hook_event_name` to internal event types (e.g. `PreToolUse` -> `pre_tool_use`)
3. Extracts `session_id` and `cwd` from JSON (not env vars)
4. Detects tmux target via `tmux display-message -t $TMUX_PANE -p '#{session_name}:#{window_index}.#{pane_index}'`
5. For `Stop` events: searches last 10 lines of transcript backwards for the assistant message (transcript ends with system/progress entries), extracts `<!--rc:CATEGORY:MESSAGE-->` markers via perl regex
6. Generates unique event ID: `{sessionId}-{timestampMs}-{randomHex}`
7. Builds ClaudeEvent JSON with `jq`

### Output
- Appends JSON line to `~/.remote-claude/data/events.jsonl`
- POSTs JSON to `http://localhost:4080/event` (backgrounded, fire-and-forget)

### Dependencies
- `jq` (JSON processing)
- `perl` (millisecond timestamps on macOS, marker regex)
- `xxd` (random hex generation)
- `curl` (HTTP POST to server)

---

## 3. Server Components

### 3.1 index.ts -- Main Entry

HTTP server on `0.0.0.0:4080` with routes:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health + stats |
| GET | `/api/sessions` | List all tracked sessions |
| GET | `/api/debug` | Debug info (sessions, events, uptime) |
| GET | `/api/directories?prefix=` | List subdirectories (for session creation) |
| GET | `/api/recent-dirs` | Recent working directories from sessions |
| GET | `/api/push/vapid-key` | Get VAPID public key for push subscriptions |
| POST | `/api/push/subscribe` | Register push subscription |
| DELETE | `/api/push/subscribe` | Unregister push subscription |
| POST | `/api/sessions` | Create managed tmux session |
| POST | `/api/sessions/:id/prompt` | Send prompt (text + optional images) |
| POST | `/api/sessions/:id/cancel` | Send Ctrl+C to session |
| POST | `/api/sessions/:id/keys` | Send tmux keys (Enter, Escape, BTab, etc.) |
| POST | `/api/sessions/:id/rename` | Rename session |
| POST | `/api/sessions/:id/dismiss` | Dismiss session from dashboard |
| POST | `/api/sessions/:id/close` | Close session (kill tmux window + remove) |
| DELETE | `/api/sessions/:id` | Kill session's tmux window |
| POST | `/event` | Ingest hook event (localhost only) |

WebSocket on `/ws` upgrade. On connect, sends: `connected`, `sessions`, per-session `history` (last 50 events per session). Streams `event`, `session_update`, `marker`, `session_removed` messages in real-time.

Static file serving from `public/` directory.

### 3.2 SessionManager.ts -- Session Lifecycle

**Auto-discovery:** When an event arrives with an unknown `sessionId`, creates a new session automatically:
- `id` = first 8 chars of Claude session UUID
- `name` = last component of cwd (e.g. "remote-claude")
- `tmuxTarget` = from event (e.g. "Personal:3.0")

**Manual creation:** Creates a named window in the shared `remote-claude` tmux session. If the session doesn't exist, creates it. Returns the tmux target (e.g. `remote-claude:1.0`).

**Deletion:** Kills the session's tmux window (not the entire tmux session), preserving other windows.

**Status tracking from hook events:**
| Event Type | Status Transition |
|-----------|-------------------|
| `user_prompt_submit` | -> working |
| `pre_tool_use` | -> working (sets currentTool) |
| `post_tool_use` | -> working |
| `stop` | -> idle |
| `notification` | -> waiting |
| `session_start` | -> idle |
| `session_end` | -> idle |

**Health checks** (every 5s): Queries `tmux list-sessions` to verify session's tmux session is still alive. For auto-discovered sessions, extracts tmux session name from `tmuxTarget`. Marks unreachable sessions as `offline`.

**Working timeout:** If a session stays in `working` for >2 minutes without events, transitions to `idle`.

**Prompt delivery:** Uses `resolveTarget()` to prefer `tmuxTarget` over `tmuxSession`. Delegates to TmuxController.

### 3.3 EventProcessor.ts -- Event Ingestion

- **Per-session** in-memory event store (max 500 events per session) -- prevents one active session from evicting another's history
- Deduplication via Set of event IDs
- Parses rc markers from `assistantText` if not already set
- Watches JSONL file with chokidar for crash recovery (reads new lines from offset)
- `getSessionHistory(sessionId)` returns events for a specific session

### 3.4 TmuxController.ts -- tmux Wrappers

- `listSessions()` -- Returns all tmux session names
- `listPanes()` -- Returns all tmux panes as `session:window.pane` targets
- `createSession(id, cwd, windowName, flags?)` -- Creates a new window in the shared `remote-claude` tmux session (creates the session if it doesn't exist). Returns the tmux target.
- `sendPrompt(target, text)` -- Safe text injection via load-buffer/paste-buffer + Enter
- `sendCancel(target)` -- Sends Ctrl+C
- `sendKeys(target, ...keys)` -- Sends whitelisted tmux keys (Enter, Escape, BTab, Tab, Space, arrow keys, Ctrl combos). Used for permission prompt responses.
- `killWindow(target)` -- Kills a tmux window by target

Target validation: `/^[a-zA-Z0-9_:.\- ]+$/` (supports `session:window.pane` format, allows spaces in session names).

### 3.5 MarkerParser.ts -- rc Marker Parsing

Parses `<!--rc:CATEGORY:MESSAGE-->` and escaped variant `<\!--rc:...-->`.
Returns `{ category, message }` or null. Validates against known categories.

### 3.6 PushManager.ts -- Web Push Notifications

Manages Web Push (VAPID) for reliable background notifications on Android/desktop.

- Generates and persists VAPID key pair to `~/.remote-claude/data/vapid-keys.json`
- Manages push subscriptions (subscribe/unsubscribe), persisted to `~/.remote-claude/data/push-subscriptions.json`
- `sendToAll(payload)` sends push notification to all registered subscriptions
- Auto-removes stale subscriptions (410/404 responses from push service)
- Push notifications triggered on status transitions: working->idle, working->waiting, any->waiting

### 3.7 TelegramBot.ts -- Telegram Forum Topics

Telegram bot (grammY) providing a parallel notification channel. Supports two modes: **forum mode** (supergroup with topics enabled, one topic per session) and **DM mode** (legacy, single chat with bind-based routing).

**Forum mode auto-detection:** On startup, calls `bot.api.getChat()` and checks `is_forum === true`. Overridable via `TELEGRAM_FORUM_MODE` env var (`auto`/`true`/`false`).

**Topic lifecycle:**
- Topics auto-created per session via `TopicManager.ensureTopic(sessionId, displayName)`
- Topics renamed when session's display name changes (fire-and-forget `editForumTopic` call)
- Closed topics reopened when the session resumes activity

**Event streaming (tool events):**
- `onEvent(event, session)` called from EventProcessor callback for each raw event
- Only `pre_tool_use` events are forwarded (avoids duplication with `post_tool_use`)
- Events buffered per-session and flushed every 3 seconds as a single batched message
- Includes assistant text snippets (what Claude said before calling the tool)
- Format: emoji + verb + subject (`📖 Reading models.py`, `🔍 Searching: pattern`, `💻 $ npm test`)
- Buffer flushed immediately on status transition out of `working`

**Status notifications:**
| Transition | Message | Sound |
|-----------|---------|-------|
| working → idle | ✅ session finished + snippet | Silent |
| working → idle (question marker) | ❓ session has a question + text | Loud |
| any → waiting | ⚠️ session needs approval + Approve/Reject buttons | Loud |
| any → offline | 🔴 session went offline | Silent |

**Pinned status message:** A live-updating message in the General topic showing all sessions with status, cwd, branch, and token count. Edited on every status change (debounced 2s). If the pinned message is deleted, a new one is created and pinned.

**Permission buttons:** Inline keyboard with Approve/Reject. On tap, sends Enter/Escape keys to tmux pane. Message self-cleans to a compact one-liner (`✅ Approved Bash on session-name (15:30)`).

**Prompt delivery:** Text messages in a session topic are delivered as prompts to that session's tmux pane. General topic messages show help text.

### 3.8 TopicManager.ts -- Forum Topic Mapping

Bidirectional mapping between session IDs and Telegram forum topic IDs. Persisted to `~/.remote-claude/data/telegram-topics.json`.

- `ensureTopic(sessionId, displayName)` -- Creates topic if needed, reopens if closed, renames if display name changed. Uses a per-session promise lock to prevent race-condition duplicate topic creation.
- `getTopicId(sessionId)` / `getSessionId(topicId)` -- Lookups
- `closeTopic(sessionId)` -- Closes topic in Telegram + marks closed in store
- `pinnedMessageId` getter/setter -- Persisted ID of the pinned status message in General

**Gotchas:**
- General topic CANNOT use `message_thread_id=1` -- must omit the parameter entirely
- Bot requires admin with "Manage Topics" permission for topic CRUD
- Concurrent `ensureTopic()` calls use a `pending` Map as mutex to prevent duplicate topics

---

## 4. Frontend (React + Vite)

React/Vite app in `frontend/`, built to `public/` as static assets. Mobile-first dark theme.

### Features
- **Session cards** sorted by priority: waiting > working > idle > offline
- **Status dots**: green pulse (working), amber fast pulse (waiting), blue static (idle), gray (offline)
- **Permission prompt UI**: Inline permission requests on session cards with Yes/Allow All/No buttons. Shows tool-specific details (file paths for Edit/Write, commands for Bash, questions for AskUserQuestion). Sends tmux keys (Enter/BTab/Escape) via `/api/sessions/:id/keys`.
- **Human-readable event feed** per selected session (newest first):
  - Shows `pre_tool_use` events only when they have assistant text or expandable tool details (Edit/Bash/Write/ExitPlanMode)
  - Deduplicates consecutive identical `assistantText` across `pre_tool_use` events
  - Bash commands show their `description` field instead of raw commands
  - Inline expandable diffs for Edit, command previews for Bash, content preview for Write, plan content for ExitPlanMode
  - MCP tools (browser automation) parsed to readable names ("Taking screenshot", "Clicking", "Navigating")
  - Agent tasks show their description ("Agent: Check Chrome dashboard state")
  - Permission requests show tool-specific summaries ("Approve edit: handler.ts")
  - **User prompts** shown in blue bubbles with the prompt text
  - **Claude responses** shown in gray bubbles on stop events (from transcript)
  - Error states shown in red
  - Long text expandable/collapsible on tap
- **Multiline textarea input** with Cmd/Ctrl+Enter to send (replaces single-line text input)
- **Session switching** by tapping cards
- **WebSocket** with auto-reconnect (exponential backoff 1s -> 30s)
- **Web Push notifications** via service worker for reliable Android background delivery
- **Client-side notifications** when page is active (instant, no push service dependency)
- **4-mode notification cycle** (off -> silent -> vibrate -> full), persisted in localStorage
- **Audio alerts** via Web Audio API (urgent two-tone for waiting, gentle chime for finished)
- **Vibration** on mobile for attention-needed events
- **Bell button** to cycle notification modes; long-press to test
- **Image upload** support in prompts (single or multiple, saved to server)
- **Multi-item prompt queue**: prompts sent while session is working are appended to a per-session queue and auto-sent sequentially on each working→idle transition; queue UI shows numbered items with individual remove, clear all, and edit last
- **Session rename** by tapping name on selected (expanded) card
- **Swipe confirmation dialogs** on swipe-to-close and swipe-to-dismiss
- **Slash command output capture** via tmux pane diffing

### Notification Triggers
| Trigger | Sound | Vibration | Web Notification |
|---------|-------|-----------|-----------------|
| working -> waiting | Urgent two-tone | 200-100-200ms | Yes, persistent |
| working -> idle | Gentle chime | 100ms | Yes |
| Marker: question/error | Urgent two-tone | 200-100-200ms | Yes, persistent |
| Marker: finished/summary/notification | Gentle chime | 100ms | Yes |
| Marker: silent/progress | None | None | None |

### Design
- Dark theme: #1C1C1E bg, #2C2C2E cards
- Mobile-first with safe-area-inset handling
- apple-mobile-web-app-capable for iOS standalone mode
- prefers-reduced-motion support
- All touch targets minimum 44px

---

## 5. Shared Types

### ManagedSession
```typescript
interface ManagedSession {
  id: string;              // Short ID (first 8 chars of Claude session UUID)
  name: string;            // Display name (from cwd)
  tmuxSession: string;     // tmux session name (for managed sessions)
  tmuxTarget?: string;     // Full target "session:window.pane" (from hook)
  status: SessionStatus;   // idle | working | waiting | offline
  createdAt: number;
  lastActivity: number;
  cwd: string;
  currentTool?: string;
  currentToolInput?: Record<string, unknown>;
  claudeSessionId?: string;
  lastMarker?: RcMarker;
  lastAssistantText?: string;
  permissionRequest?: { tool: string; toolInput: Record<string, unknown> };
  windowName?: string;     // For managed sessions
  flags?: string;          // CLI flags (e.g. "--dangerously-skip-permissions")
  gitBranch?: string;      // Current git branch from hook events
  gitDirty?: boolean;      // Whether working tree has uncommitted changes
  totalTokens?: number;    // Cumulative token usage
}
```

### ClaudeEvent
```typescript
interface ClaudeEvent {
  id: string;              // Unique: sessionId-timestamp-randomHex
  timestamp: number;       // Milliseconds
  type: HookEventType;     // pre_tool_use | post_tool_use | stop | etc.
  sessionId: string;       // Claude Code session UUID
  cwd: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  success?: boolean;
  error?: string;
  assistantText?: string;  // Last ~200 chars of assistant response (stop events)
  marker?: RcMarker;       // Parsed rc marker
  tmuxTarget?: string;     // "session:window.pane"
  gitBranch?: string;      // Current git branch
  gitDirty?: boolean;      // Uncommitted changes
  totalTokens?: number;    // Cumulative token usage
}
```

---

## 6. Setup & Security

### Setup Process (npm run setup)
1. Creates `~/.remote-claude/data/` and `~/.remote-claude/hooks/`
2. Copies hook script, makes executable
3. Registers hooks in `~/.claude/settings.json` for all 7 event types
4. Generates 32-byte auth token (saved to `auth-token.txt`, mode 0600)
5. Prints server URL and LAN access URL with token

### Security
- **Cloudflare Tunnel + Access** -- Internet access via `claude.maksim.xyz` with GitHub OAuth (see `docs/INTERNET-EXPOSURE.md`)
- **`/event` endpoint protection** -- Blocks requests with `CF-Connecting-IP` header (Cloudflare tunnel traffic) + validates `X-Hook-Secret` header (defense in depth)
- **Bind address** -- `0.0.0.0:4080` by default, configurable via `BIND_HOST` env var
- **Prompt injection safe** -- tmux load-buffer/paste-buffer avoids shell interpretation
- **Target validation** -- Regex check on all tmux targets
- **10MB body limit** on HTTP requests (supports image uploads)
- **CORS** -- Configurable via `CORS_ORIGIN` env var (defaults to `*` for LAN, set to domain for internet)
- **Security headers** -- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`

---

## 7. Implementation Gotchas

- **Notification hook types**: Claude Code's `Notification` hook fires with `notification_type` field in stdin JSON: `idle_prompt`, `permission_prompt`, `auth_success`, `elicitation_dialog`. Our hook doesn't currently extract this field.
- **`idle_prompt` timing**: Fires exactly 60s after Stop -- this is Claude Code core behavior, not a Remote Claude bug.
- **Service worker source path**: `frontend/public/sw.js` is the source. Vite copies it to `public/sw.js` on build. Editing `public/sw.js` directly gets overwritten.
- **Permission request fallback**: Permission request data falls back to preceding `pre_tool_use` event when the notification event lacks tool info.
- **`public/index.html`** is a build artifact from the React frontend -- don't edit directly.
- **Telegram General topic**: Sending with `message_thread_id=1` is rejected by Telegram API. Must omit the parameter entirely to send to General topic.
- **Telegram rate limits**: Group chats have ~20 messages/minute limit. Tool events are batched per-session every 3 seconds to stay within limits.
- **`currentToolInput` clearing**: On `post_tool_use`, `currentToolInput` is set to undefined (while `currentTool` is kept). Event streaming captures tool info at event time, not on flush.
- **Topic rename race**: `ensureTopic()` fast path checks for name mismatch and fires rename asynchronously. Store is updated immediately to prevent redundant rename attempts.

---

## 8. What's Not Built Yet

See `docs/ROADMAP.md` for the full list. Key gaps:

- Voice/TTS (Web Speech API)
- Notification priority tiers (P0-P3)
- Session detail view with full history
- Bottom tab navigation / Activity feed / Settings screen
- Multi-user support
