# Telegram Integration -- Implementation Design

Detailed design for adding Telegram as a notification and control channel.
Read `RESEARCH.md` first for context on prior art and the hybrid approach.

---

## Architecture

```
Claude Code (in tmux)
  |
  |-- Hook fires (instant) --> Server --> SessionManager
  |                                         |
  |                                         |--> WebSocket (dashboard, existing)
  |                                         |--> TelegramBot (NEW: status alerts)
  |
  |-- JSONL transcript (append-only file)
        |
        `--> TranscriptPoller (NEW, 2s) --> TelegramBot (rich content messages)
```

Two new server components:
1. **TelegramBot** (`server/TelegramBot.ts`) -- grammY bot, sends/receives messages
2. **TranscriptPoller** (`server/TranscriptPoller.ts`) -- reads JSONL transcripts,
   extracts full content, feeds to TelegramBot

### Data flow: outbound (Claude -> Telegram)

**Status alerts (from hooks, instant):**
```
Hook event -> SessionManager.updateSession() -> TelegramBot.onStatusChange()
  - working -> idle:    "Session X finished. [marker message if any]"
  - working -> waiting: "Session X needs attention: [permission details]"
  - any -> offline:     "Session X went offline"
```

**Rich content (from JSONL, 2s latency):**
```
TranscriptPoller reads new JSONL lines -> parses entries -> TelegramBot.onContent()
  - Assistant text:  full response (split if > 4096 chars)
  - Tool use:        "Read(file.py)" / "Bash(npm test)" / "Edit(main.py)"
  - Tool result:     edit tool_use message with result summary + expandable detail
  - Thinking:        expandable blockquote
```

**Deduplication between hooks and JSONL:**
- Hooks trigger status alerts (idle/waiting/offline) -- these are STATUS messages
- JSONL triggers content messages (text, tools, thinking) -- these are CONTENT messages
- They don't overlap because they carry different information
- If we later want hook events to also show content, dedup by `tool_use_id`

### Data flow: inbound (Telegram -> Claude)

```
User sends text in Telegram chat
  -> TelegramBot receives message
  -> Resolves which session the chat is bound to
  -> server.sendPrompt(sessionId, text)  (existing tmux injection)
  -> Claude Code receives input
```

For permission responses (inline keyboard):
```
User taps [Yes] / [No] button
  -> TelegramBot receives callback_query
  -> server.sendKeys(sessionId, "Enter" or "Escape")
  -> Claude Code receives key
```

---

## Component Design

### TelegramBot (`server/TelegramBot.ts`)

```
Dependencies: grammy
Config: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (single-user DM mode)
```

**Initialization:**
- Create grammY Bot instance
- Start long-polling (no webhook, no tunnel dependency)
- Register command handlers: /sessions, /status, /bind, /help
- Register message handler (text -> prompt injection)
- Register callback_query handler (button presses)

**Session binding (v1: simple DM mode):**
- Single chat (the user's DM with the bot)
- User sends message -> routed to the "active" session
- `/bind <session-name>` switches which session receives messages
- `/sessions` lists sessions with status indicators, tap to bind
- When a session enters `waiting`, it auto-becomes the active session

**Alternative (v2: topic mode):**
- Telegram group with forum topics enabled
- 1 topic per session (like ccbot)
- Messages in a topic route to that session
- New sessions auto-create topics
- More complex but better for multi-session workflows

**Status notifications:**
Subscribe to SessionManager events. On status change:

| Transition | Message | Keyboard |
|---|---|---|
| working -> idle | `Session done. [marker]` | -- |
| working -> idle (question marker) | `Session has a question: [text]` | -- |
| working -> waiting (permission) | `Approve? [tool] [details]` | `[Yes] [Allow All] [No]` |
| any -> offline | `Session offline` | -- |

Format as HTML with expandable blockquote for long assistant text.

**Prompt delivery:**
- Receive text message from user
- Look up active session (or topic-bound session)
- Call existing `POST /api/sessions/:id/prompt` internally
  (or call SessionManager.sendPrompt directly)
- Send typing indicator while Claude works

### TranscriptPoller (`server/TranscriptPoller.ts`)

```
Dependencies: fs (node built-in)
Config: poll interval (default 2000ms)
```

**Core loop (adapted from ccbot's proven pattern):**
1. For each active session, get transcript path
   - Our hook already receives `transcript_path` in stdin JSON
   - Store it per-session in SessionManager when processing stop/tool events
   - Alternatively: construct from `~/.claude/projects/{encodedCwd}/{sessionId}.jsonl`
2. Check file mtime -- skip if unchanged since last poll
3. Read from `lastByteOffset` to end of file
4. Parse each line as JSON
5. Extract content entries (assistant text, tool_use, tool_result, thinking)
6. Pair tool_use with tool_result via `tool_use_id` (carry pending across cycles)
7. Emit to TelegramBot for formatting and sending

**State persistence:**
- `~/.remote-claude/data/transcript-offsets.json`: `{ [sessionId]: byteOffset }`
- Saved periodically (every 10s) and on shutdown
- On startup, resume from saved offsets (crash recovery)

**Entry types to handle:**

| JSONL type | Content blocks | Action |
|---|---|---|
| `assistant` | `text` | Send as message (split if long) |
| `assistant` | `thinking` | Send as expandable blockquote |
| `assistant` | `tool_use` | Send tool summary, store in pending |
| `assistant` | `tool_result` | Edit tool_use message with result |
| `user` | `text` | Skip (user already knows what they sent) |
| `summary` | -- | Skip (internal metadata) |

**Transcript path discovery:**
The hook's stdin JSON includes `transcript_path` for Stop events. We should:
1. Extract `transcript_path` in the hook script (we partially do this already)
2. Include it in ClaudeEvent
3. SessionManager stores it per-session
4. TranscriptPoller uses it directly (no globbing needed)

If transcript_path is unavailable (older sessions), fall back to:
`~/.claude/projects/-{cwd with slashes replaced by dashes}/sessions/{sessionId}.jsonl`

---

## Message Formatting

### HTML formatting (not MarkdownV2)

Use `parse_mode: "HTML"` for all messages. Simpler than MarkdownV2, fewer
escaping issues. See RESEARCH.md for rationale.

**Escaping:** Only `<`, `>`, `&` need escaping (standard HTML entities).

### Message templates

**Status: session finished**
```html
<b>remote-claude</b> finished
<blockquote expandable>Claude's response text here, can be long...</blockquote>
```

**Status: session waiting (permission)**
```html
<b>remote-claude</b> needs approval

<b>Bash</b>: <code>rm -rf node_modules</code>
```
With inline keyboard: `[Yes] [Allow All] [No]`

**Content: assistant text**
```html
Claude's response here. Can include <code>inline code</code> and
<pre>code blocks</pre> as appropriate.
```

**Content: tool use**
```html
<b>Read</b>(<code>src/main.ts</code>)
```

**Content: tool result (edits tool_use message)**
```html
<b>Read</b>(<code>src/main.ts</code>)
-- 42 lines
<blockquote expandable>First few lines of content...</blockquote>
```

**Content: Edit with diff**
```html
<b>Edit</b>(<code>src/main.ts</code>)
+3 -1 lines
<blockquote expandable><pre>
-old line
+new line
 context
+added line
</pre></blockquote>
```

**Content: thinking**
```html
<blockquote expandable>Claude's reasoning here, collapsed by default...</blockquote>
```

### Message splitting

When content exceeds 4096 chars:
1. Prefer splitting on newline boundaries
2. Never split inside an HTML tag or expandable blockquote
3. Add `[1/N]` suffix to multi-part messages
4. Send parts sequentially (Telegram preserves order within a chat)

---

## Configuration

### Environment variables

```bash
# Required for Telegram (skip to disable)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...    # From @BotFather
TELEGRAM_CHAT_ID=987654321              # Your user/chat ID

# Optional
TELEGRAM_POLL_INTERVAL=2000             # Transcript poll interval (ms)
TELEGRAM_NOTIFY_IDLE=true               # Notify on working->idle
TELEGRAM_NOTIFY_WAITING=true            # Notify on working->waiting
```

### Setup flow

1. Create bot via @BotFather, get token
2. Send `/start` to bot, get your chat_id (bot can report it)
3. Set env vars in `~/.remote-claude/.env` or shell
4. Restart server -- bot starts automatically if token is set
5. Send `/sessions` to verify connection

### Graceful degradation

If `TELEGRAM_BOT_TOKEN` is not set:
- TelegramBot is not instantiated
- TranscriptPoller is not started
- Server works exactly as before (dashboard-only mode)
- No error, no warning (just a log line: "Telegram not configured, skipping")

---

## Implementation Plan

### Phase 1: Skeleton + status notifications (hooks-only)

Fastest path to "Telegram pings me when Claude needs something":

1. Add `grammy` dependency
2. Create `TelegramBot.ts` with grammY long-polling
3. Subscribe to SessionManager status changes
4. Send status messages (idle, waiting, offline) as HTML
5. Inline keyboard for permission approve/reject
6. `/sessions` command
7. Basic prompt delivery (text message -> active session)

**This gives us:** reliable notifications + basic control. No JSONL yet.

### Phase 2: JSONL transcript polling (rich content)

Add the content layer:

1. Extract `transcript_path` from hook events, store per-session
2. Create `TranscriptPoller.ts` (byte-offset JSONL reader)
3. Parse transcript entries (text, tool_use, tool_result, thinking)
4. Send formatted content to Telegram
5. Edit tool_use messages with results
6. Expandable blockquotes for thinking and long outputs

**This gives us:** ccbot-level rich messages in Telegram.

### Phase 3: Polish

- Message merging (consecutive texts within 3800 chars)
- Typing indicator while Claude works
- Rate limiting (1s between messages)
- `/status` command with detailed session info
- Error handling (bot reconnection, transcript file rotation)
- Persist transcript offsets for crash recovery

### Phase 4 (future): Topic mode

- Enable forum topics in Telegram group
- Auto-create topic per session
- Route messages by topic -> session
- Topic lifecycle (close topic when session ends)

---

## Open Questions

1. **DM vs Group?** v1 uses DM (simpler). But a group with forum topics gives
   per-session threading. ccbot requires forum mode. We could start with DM and
   add topic mode later.

2. **What triggers content messages?** Should every tool_use/result generate a
   Telegram message? Or only "interesting" ones? ccbot sends everything. We
   might want a quieter mode (only final response + errors).

3. **Notification vs content timing.** Hook says "session idle" instantly. JSONL
   content arrives 2s later. Should the idle notification include the final
   response (wait for JSONL)? Or send immediately and follow up with content?

4. **Transcript path reliability.** We get `transcript_path` in Stop events.
   Do we get it in other events? Need to verify. If not, we need the fallback
   path construction.

5. **Multiple devices.** If web dashboard and Telegram are both active, should
   Telegram suppress notifications? Or always send? (Probably always send --
   the user chose to enable it.)

---

## Files to Create/Modify

### New files
- `server/TelegramBot.ts` -- grammY bot, message formatting, command handlers
- `server/TranscriptPoller.ts` -- JSONL reader, entry parsing, content extraction
- `server/telegram-format.ts` -- HTML formatting helpers (escaping, splitting, templates)

### Modified files
- `server/index.ts` -- instantiate TelegramBot + TranscriptPoller if configured
- `server/SessionManager.ts` -- emit status change events for TelegramBot to consume;
  store transcript_path per session
- `shared/types.ts` -- add transcript_path to ClaudeEvent (if not already)
- `hooks/remote-claude-hook.sh` -- extract transcript_path from stdin, include in event
- `package.json` -- add grammy dependency

### Not modified
- Frontend (Telegram is independent of web dashboard)
- `shared/config.ts` (config is env-var based, not shared config)
