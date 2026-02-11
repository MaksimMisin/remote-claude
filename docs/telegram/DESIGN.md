# Telegram Integration -- Implementation Design

Detailed design for Telegram as a notification and control channel.
Read `RESEARCH.md` first for the full competitive landscape and UX analysis.

---

## Core Principle: Telegram is the PRIMARY Remote Interface

**Telegram MUST have at least the same level of detail as the web dashboard,
and should aim to have MORE.** Telegram is frankly a better environment for
remote control — it has native notifications, forum topics, inline keyboards,
reactions, expandable blockquotes, and persistent chat history. The web
dashboard is a fallback for when Telegram isn't configured.

Both channels receive the same event stream from the server. Telegram formats
events for chat (batched, HTML-formatted) while the web dashboard formats them
for a scrollable React UI. Telegram should never be a stripped-down version —
it should be the richer, more capable interface.

---

## Current State

Implemented and working:
- Forum topics mode: one topic per session, auto-created
- **Real-time event streaming**: tool activity + assistant text batched per 3s
- Status notifications: working->idle, working->waiting, any->offline
- Inline keyboard for permission approve/reject
- `/sessions`, `/bind`, `/status`, `/help` commands
- Text messages delivered as prompts to session topics
- Topic title updated with status emoji prefix
- DM mode fallback for non-forum chats
- HTML formatting via `telegram-format.ts`

---

## Architecture

```
Claude Code (in tmux)
  |
  |-- Hook fires (instant) --> Server --> EventProcessor
                                            |
                                            |--> WebSocket broadcast (dashboard)
                                            |--> TelegramBot.onEvent() (event stream)
                                            |--> SessionManager.handleEvent()
                                                   |
                                                   |--> TelegramBot.onStatusChange()
```

### Data flow: outbound (Claude -> Telegram)

**Event streaming (from hooks, instant, batched per 3s):**
```
Hook event -> EventProcessor -> TelegramBot.onEvent()
  - pre_tool_use:       Tool icon + description + assistant text snippet
  - stop:               ✅ Marker message + response text (expandable)
  - user_prompt_submit:  💬 User prompt text
  -> Buffered per session, flushed as one message every 3 seconds
  -> Flushed immediately on status transition (leaving working state)
```

**Status alerts (from session manager, instant):**
```
SessionManager.updateSession() -> TelegramBot.onStatusChange()
  - working -> idle:    "Session X finished. [marker message if any]"
  - working -> waiting: "Session X needs attention: [permission details]"
  - any -> offline:     Topic deleted
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

**Session offline:** Topic is closed (locked, red emoji). Happens after a 5s
`session_end` timer or when the tmux pane dies (health check).

**Session replaced (same pane):** When `/clear` or a clean-context plan restart
creates a new Claude session on the same pane, the topic is **transferred** —
not deleted and recreated. This is critical: `onSessionReplaced` transfers the
topic mapping, `onSessionRemoved` is NOT called. The user sees one continuous
topic for the lifetime of a tmux pane, regardless of how many Claude sessions
run in it.

**Session removed from dashboard:** Topic is deleted entirely.

### Topic naming and display names

Each session has two name slots:

- **Auto name** (`windowName`) — passively mirrors the tmux window title. Updated
  by the health check every ~10s. Includes both hook-generated LLM summaries
  (e.g. `🤖 auth fix`) and manual tmux renames. Not sticky — changes freely.
- **Pinned name** (`customName`) — set only from a Telegram topic rename or a
  Dashboard rename. Sticky until explicitly cleared.

Display priority: `pinned > auto > fallback`. This is implemented in
`telegram-format.ts:getDisplayName()` which returns `customName > windowName
(emoji-stripped) > name`.

| Scenario | Behavior |
|---|---|
| Hook generates LLM summary for tmux window | Auto updates, all surfaces update (if no pin) |
| User renames Telegram topic | Sets pin, all surfaces show pinned name |
| User renames in Dashboard | Sets pin, all surfaces show pinned name |
| Hook fires again after pin | Auto updates silently. Pin still wins. |
| User clears pin (empty rename) | Reverts to current auto name |
| User manually renames tmux window | Treated as auto (same as hook) |

**Propagation flow:**

```
tmux window renamed (by hook or user)
  -> health check detects new windowName (~10s)
  -> SessionManager.updateSession() fires onSessionUpdate callback
  -> index.ts compares getDisplayName() against prevDisplayNames map
  -> if changed: TelegramBot.onDisplayNameChange(session)
    -> TopicManager.updateTopicTitle() updates topic with status emoji + new name
```

Key principle: **tmux is read-only for Remote Claude.** We never write to tmux
window titles. Pin only from Telegram or Dashboard. Telegram topic renames
set `customName` via `renameSession()`, which the web dashboard also uses.

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

### Phase 1: DM mode -- DONE

Status notifications, inline keyboards, basic commands, prompt delivery.

### Phase 2: Forum topics mode -- DONE

Auto-created topics per session, topic lifecycle, status emoji in titles,
prompt routing by topic, topic deletion on offline.

### Phase 3: Event streaming -- DONE

Real-time event streaming to forum topics via hook-based events:
- pre_tool_use events: tool icon + description + assistant reasoning
- stop events: marker message + response text (expandable blockquote)
- user_prompt_submit: prompt text
- Batched per 3 seconds, flushed immediately on status transition
- Uses formatEventLine() for consistent tool formatting

### Phase 4: UX polish

- Silent vs loud notifications (disable_notification)
- ACK emoji reactions on prompt delivery
- Persistent reply keyboard (DM mode only)

### Phase 5: Telegram-native enhancements (beyond web dashboard)

Telegram should EXCEED the web dashboard's capabilities:
- Voice message transcription for prompt delivery
- Message queuing with `!` interrupt
- Concat mode for complex prompts on mobile
- Topic auto-close after offline timeout
- Rich tool result previews (edit diffs, command output)
- Thinking block streaming via expandable blockquotes
- Image/screenshot forwarding from browser tools

---

## Open Questions

1. ~~**Topic naming.**~~ Resolved: topics use `getDisplayName()` (pinned >
   auto > fallback). Auto name tracks tmux window title, propagated to
   Telegram topics on change. See "Topic naming and display names" above.

2. ~~**Topic reuse.**~~ Resolved: topics are transferred on session replacement
   (same pane). One continuous topic per tmux pane, across /clear, plan
   restarts, and server restarts (via `closeStaleTopics` + reopen).

3. **Notification grouping.** If 3 sessions finish within seconds, should we
   batch into one pinned-message update, or send 3 separate updates? The
   pinned message handles this naturally (one edit = latest state).

4. **DM vs Group default.** Should `npm run setup` guide users to create a
   group, or default to DM mode? DM is simpler for getting started; group
   is better long-term. Probably: start with DM, suggest group upgrade when
   the user has 3+ sessions.

---

## Files

- `server/TelegramBot.ts` -- grammY bot, commands, callbacks, event streaming, notifications
- `server/telegram-format.ts` -- HTML formatting, event lines, message splitting, templates
- `server/TopicManager.ts` -- topic lifecycle, sessionId<->topicId mapping, persistence
- `shared/defaults.ts` -- `TELEGRAM_MESSAGE_LIMIT` constant
- `server/index.ts` -- wires EventProcessor → TelegramBot.onEvent() and SessionManager → onStatusChange()
