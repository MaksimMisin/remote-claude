# Telegram Integration -- Implementation Design

Detailed design for Telegram as a notification and control channel.
Read `RESEARCH.md` first for the full competitive landscape and UX analysis.

---

## Current State (v1: DM Mode)

Phase 1 is implemented and working:
- grammY bot with long-polling
- Status notifications: working->idle, working->waiting, any->offline
- Inline keyboard for permission approve/reject
- `/sessions`, `/bind`, `/status`, `/help` commands
- Text messages delivered as prompts to the bound session
- Auto-bind on permission events
- HTML formatting via `telegram-format.ts`

**What's wrong with v1:** All sessions share one DM chat. With 3+ concurrent
sessions, notifications interleave into an unreadable stream. The bound session
is invisible state. Permission buttons get buried. See RESEARCH.md "Verdict"
section -- no project has solved single-chat multi-session elegantly.

---

## Architecture

```
Claude Code (in tmux)
  |
  |-- Hook fires (instant) --> Server --> SessionManager
  |                                         |
  |                                         |--> WebSocket (dashboard, existing)
  |                                         |--> TelegramBot (status alerts)
  |
  |-- JSONL transcript (append-only file)
        |
        `--> TranscriptPoller (future) --> TelegramBot (rich content messages)
```

### Data flow: outbound (Claude -> Telegram)

**Status alerts (from hooks, instant):**
```
Hook event -> SessionManager.updateSession() -> TelegramBot.onStatusChange()
  - working -> idle:    "Session X finished. [marker message if any]"
  - working -> waiting: "Session X needs attention: [permission details]"
  - any -> offline:     "Session X went offline"
```

**Rich content (from JSONL, future -- 2s latency):**
```
TranscriptPoller reads new JSONL lines -> parses entries -> TelegramBot.onContent()
  - Assistant text:  full response (split if > 4096 chars)
  - Tool use:        "Read(file.py)" / "Bash(npm test)" / "Edit(main.py)"
  - Tool result:     edit tool_use message with result summary + expandable detail
  - Thinking:        expandable blockquote
```

### Data flow: inbound (Telegram -> Claude)

```
User sends text in Telegram
  -> TelegramBot receives message
  -> Routes to session (by topic in v2, by active bind in v1)
  -> server.sendPrompt(sessionId, text)  (tmux injection)
  -> Claude Code receives input
```

For permission responses (inline keyboard):
```
User taps [Approve] / [Reject]
  -> TelegramBot receives callback_query
  -> server.sendKeys(sessionId, "Enter" or "Escape")
  -> Claude Code receives key
```

---

## v2: Forum Topics Mode

### Why forum topics

After surveying 10+ implementations (RESEARCH.md), every project that handles
multi-session well uses forum topics (ccc, OpenClaw, ccbot). The pattern is
proven and maps naturally to our problem:

- **Session = topic.** Each Claude Code session gets its own topic.
- **Topic list = session list.** Telegram's native UI is the dashboard.
- **Zero interleaving.** Messages from different sessions never mix.
- **Natural routing.** Message in topic X goes to session X. No bind command.
- **Independent notifications.** Telegram lets you mute/unmute individual topics.

### Setup changes

v1 (current): User DMs the bot directly.
v2 (topics):  User creates a Telegram group, enables topics, adds bot as admin.

One-time setup:
1. Create a Telegram Group (or use existing)
2. Enable Topics in group settings
3. Add bot to group as admin (needs: manage topics, send messages, pin messages)
4. Set `TELEGRAM_CHAT_ID` to the group ID (negative number)
5. Optionally set `TELEGRAM_FORUM_MODE=true` (or auto-detect from group type)

### Topic lifecycle

**Auto-creation:** When a new session appears (first hook event), the bot calls
`createForumTopic` with the session's display name. Stores the mapping:
`sessionId -> topicId` in `~/.remote-claude/data/telegram-topics.json`.

**Naming:** Topic name = session display name (e.g. "bot debug", "ai-mvp").
Topic icon = status emoji (optional, if API supports custom emoji).

**Session offline:** Don't close the topic immediately -- session may come back.
After a configurable timeout (e.g. 30 minutes), close the topic.
Closed topics are still visible but move to the bottom of the list.

**Session removed from dashboard:** Close the topic. User can manually delete.

### Message routing

**Outbound (bot -> group):** All `sendMessage` calls include
`message_thread_id: topicId`. Messages appear only in their session's topic.

**Inbound (user -> bot):** The `message_thread_id` in incoming messages
identifies which topic the user is typing in. Map `topicId -> sessionId` for
prompt delivery. No bind command needed.

### General topic

The "General" topic (always exists in forum groups) serves as the control
channel:
- `/sessions` posts here (with inline keyboard to jump to topics)
- Pinned live-status message lives here (edited on every status change)
- Bot startup/shutdown messages go here
- Messages without a topic context route here

### Pinned status message in General topic

One pinned message, edited on every status change:

```html
<b>Sessions</b> (updated 11:30)

🔵 <b>debug trace replay</b> -- working (Bash)
   ~/code/ai-mvp | feat/replay-browse-rewind | 57k tok
🟢 <b>bot debug</b> -- idle
   "Pushed 3 commits to origin/main"
🟢 <b>ai-mvp</b> -- idle
   ~/code/replika/ai-mvp | main
```

This provides the at-a-glance overview that the web dashboard gives, without
requiring any commands.

### DM fallback

If the bot receives a DM (not in a group), fall back to v1 behavior:
single-chat mode with /bind. This keeps the bot usable for simple setups
and for users who don't want to create a group.

---

## UX Enhancements (both v1 and v2)

### Silent vs loud notifications

Use `disable_notification: true` for FYI messages:
- **Loud** (phone buzzes): permission requests, questions
- **Silent** (no buzz): session finished, went offline, status updates

### Self-cleaning permission buttons

After approve/reject, edit the original message:
```
Before: "bot debug needs approval\n\nBash: rm -rf node_modules\n[Approve] [Reject]"
After:  "Approved Bash on bot debug (11:30)"
```
Removes buttons and condenses to one line.

### ACK emoji reactions

When user sends a prompt, react with a processing emoji (e.g. hourglass).
Remove the reaction when Claude's response arrives. Provides instant feedback
without cluttering the chat with "message sent" confirmations.

### Expandable blockquotes for long content

Use `<blockquote expandable>` for:
- Assistant response text (when > ~500 chars)
- Thinking blocks
- Tool results (file contents, command output)

These collapse by default, keeping the chat scannable.

### Persistent reply keyboard (optional)

For DM mode (v1), add always-visible buttons at the bottom:
```
[Sessions] [Status] [Stop]
```
Reduces typing on mobile. Not needed in topic mode where context is implicit.

---

## Message Formatting

### HTML formatting (not MarkdownV2)

Use `parse_mode: "HTML"` for all messages. Simpler than MarkdownV2, fewer
escaping issues. Only `<`, `>`, `&` need escaping.

### Message templates

**Status: session finished**
```html
✅ <b>remote-claude</b> finished
<blockquote expandable>Claude's response text here, can be long...</blockquote>
```

**Status: session waiting (permission)**
```html
⚠️ <b>remote-claude</b> needs approval

<b>Bash</b>: <code>rm -rf node_modules</code>
```
With inline keyboard: `[Approve] [Reject]`

**Status: session has a question**
```html
❓ <b>remote-claude</b> has a question
  Checking if user received bot replies in Telegram
```

**Status: session offline**
```html
🔴 <b>remote-claude</b> went offline
```

### Message splitting

When content exceeds 4096 chars:
1. Prefer splitting on newline boundaries
2. Never split inside an HTML tag or expandable blockquote
3. Send parts sequentially (Telegram preserves order within a chat)

---

## Configuration

### Environment variables

```bash
# Required for Telegram (skip to disable)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...    # From @BotFather
TELEGRAM_CHAT_ID=987654321              # User ID (DM) or group ID (topics)

# Optional
TELEGRAM_FORUM_MODE=auto                # auto | true | false
```

`TELEGRAM_FORUM_MODE=auto` detects whether `TELEGRAM_CHAT_ID` points to a
forum-enabled group (via `getChat` API) and enables topic mode automatically.

### Graceful degradation

If `TELEGRAM_BOT_TOKEN` is not set:
- TelegramBot is not instantiated
- Server works exactly as before (dashboard-only mode)
- No error, just a log line: "Telegram not configured, skipping"

---

## Implementation Plan

### Phase 1: Hooks-only DM mode -- DONE

Status notifications, inline keyboards, basic commands, prompt delivery.

### Phase 2: Forum topics mode

1. Add `createForumTopic` / topic management to TelegramBot
2. Store `sessionId -> topicId` mapping (persisted to disk)
3. Route outbound messages by `message_thread_id`
4. Route inbound messages by `message_thread_id -> sessionId`
5. Auto-create topics for new sessions
6. Pinned status message in General topic
7. DM fallback when not in a group

### Phase 3: UX polish

- Silent vs loud notifications
- Self-cleaning permission buttons
- ACK emoji reactions
- Expandable blockquotes
- Persistent reply keyboard (DM mode only)

### Phase 4: Rich content via JSONL polling

Add the content layer (ccbot-inspired):

1. Extract `transcript_path` from hook events, store per-session
2. Create `TranscriptPoller.ts` (byte-offset JSONL reader)
3. Parse transcript entries (text, tool_use, tool_result, thinking)
4. Send formatted content to Telegram
5. Edit tool_use messages with results
6. Expandable blockquotes for thinking and long outputs
7. Message merging (consecutive texts within 3800 chars)
8. Persist transcript offsets for crash recovery

### Phase 5: Advanced features (future)

- Message queuing with `!` interrupt (linuz90 pattern)
- Concat mode for complex prompts on mobile
- Voice message transcription
- Topic auto-close after offline timeout

---

## Open Questions

1. **Topic naming.** Should topics include the tmux target for disambiguation,
   or just the display name? Display name is cleaner but may collide if two
   sessions have the same name.

2. **Topic reuse.** If a session goes offline and comes back (e.g. server
   restart), should it reuse the existing topic? Probably yes -- match by
   session display name or tmux target.

3. **Notification grouping.** If 3 sessions finish within seconds, should we
   batch into one pinned-message update, or send 3 separate updates? The
   pinned message handles this naturally (one edit = latest state).

4. **DM vs Group default.** Should `npm run setup` guide users to create a
   group, or default to DM mode? DM is simpler for getting started; group
   is better long-term. Probably: start with DM, suggest group upgrade when
   the user has 3+ sessions.

---

## Files

### Existing (v1)
- `server/TelegramBot.ts` -- grammY bot, commands, callbacks, notifications
- `server/telegram-format.ts` -- HTML formatting, message splitting, templates
- `shared/defaults.ts` -- `TELEGRAM_MESSAGE_LIMIT` constant

### To create (v2)
- `server/TopicManager.ts` -- topic lifecycle, sessionId<->topicId mapping
- `server/TranscriptPoller.ts` -- JSONL reader (phase 4)

### To modify (v2)
- `server/TelegramBot.ts` -- add topic routing, pinned message, DM fallback
- `server/telegram-format.ts` -- pinned status message template
- `server/index.ts` -- pass forum mode config to TelegramBot
