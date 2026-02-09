# Telegram Integration -- Research & Prior Art

Survey of existing Claude Code + Telegram projects, UX patterns, and our
conclusions on the best path forward for multi-session remote control.

Last updated: 2025-02-09

---

## Projects Surveyed

### 1. ccbot (six-ddc/ccbot) -- Python, JSONL polling

**The gold standard for rich Telegram output from Claude Code.**

Architecture: SessionStart hook writes `session_map.json` (window -> session_id),
then a 2-second async poller reads JSONL transcripts with byte-offset tracking.
One Telegram forum topic per tmux window per session.

What it does well:
- **Full message content**: reads entire JSONL transcript, not just hook metadata
- **Tool result editing**: sends tool_use message, then edits it in-place when
  result arrives (e.g. `**Read**(file.py)` becomes `**Read**(file.py) -- 42 lines`)
- **Thinking blocks**: collapsed Telegram blockquotes (`>text||`)
- **Diff formatting**: computes unified diffs from Edit tool results
- **Message merging**: consecutive content messages merge if <= 3800 chars
- **Crash recovery**: byte-offset state persisted, resumes after restart
- **Interactive UI**: inline keyboards for arrow keys, Enter, Esc, Ctrl-C

What it lacks vs us:
- 2-second latency for everything (no instant status notifications)
- Only SessionStart hook -- if bot is down when session starts, session is invisible
- No health checks (doesn't verify tmux panes are alive)
- No git context, no token tracking
- No Web Push fallback

Key technical details:
- Uses `telegramify-markdown` for standard -> MarkdownV2 conversion
- 4096-char Telegram limit, splits on newlines, expandable quotes are atomic
- Rate limits: 1.1s min between messages per user
- Tool pairing: `pending_tools[tool_use_id]` carries across poll cycles

### 2. Claude-Code-Remote (JessyTsui) -- Node.js, hooks-only -- 1,025 stars

**Most popular project. Multi-channel (Email+Telegram+LINE+Desktop).**

Hook-based (Stop + SubagentStop). Sends notifications on completion/waiting.

What it does well:
- Multi-channel (email gets full terminal output, Telegram gets buttons)
- PTY mode (no tmux dependency) as default, tmux as fallback
- Interactive setup wizard auto-merges hooks into `~/.claude/settings.json`
- Token-based session linking: 24-hour tokens tie notifications to sessions
- Smart monitor distinguishes real responses from subagent activity

What it lacks:
- Only fires on Stop/SubagentStop -- no real-time tool tracking
- Telegram interaction is clunky (token-based command format: `/cmd TOKEN123 msg`)
- No message content (just "task completed" / "waiting for input")
- Multi-session UX is the weakest -- must copy-paste tokens

### 3. claudecode-telegram (hanxiao) -- Python, webhook + hooks -- 421 stars

Stop hook reads transcript, sends response to Telegram via Bot API.
Telegram messages come in via Cloudflare tunnel to bridge server, injected
as tmux keystrokes. Uses "pending file" flag to only respond to
Telegram-initiated messages.

What it does well:
- Extremely simple (~200 lines of Python)
- `/resume` command with inline keyboard session picker
- `/loop <prompt>` for automated iteration (run N times)
- Pending-file flag prevents echoing terminal-initiated conversations

What it lacks:
- Single tmux session by default
- Not designed for monitoring multiple concurrent sessions
- No streaming, no message editing

HN creator's insight: "the terminal stays the source of truth" -- don't create
isolated API sessions that you can't resume in your terminal.

### 4. claude-telegram-bot (linuz90) -- TypeScript/Bun, Agent SDK -- 357 stars

**Most sophisticated single-session UX.** Uses `@anthropic-ai/claude-agent-sdk`
to spawn new Claude instances. Fundamentally different paradigm from monitoring.

What it does well:
- **Streaming with message editing**: creates msg, edits as content streams
- **Tool use as ephemeral messages**: shows "Read file.py" then deletes when done
- **`ask_user` MCP tool**: Claude's questions rendered as tappable inline buttons
  (file-based IPC: MCP writes JSON to /tmp, bot polls, renders buttons)
- **Message queuing**: send multiple messages while Claude works; `!` interrupts
- **Concat mode**: toggle to batch multiple messages before sending
- Voice transcription (OpenAI Whisper), photo/document support
- Extended thinking triggered by keywords ("think", "reason")

Permission handling: `permissionMode: "bypassPermissions"` -- deliberate choice
for mobile UX, mitigated by user allowlist + AI intent filtering.

**Not applicable to our monitoring use case**, but several UX patterns are worth
stealing: streaming edits, ask_user buttons, message queuing, concat mode.

### 5. ccc (kidandcat) -- Go, tmux + polling -- 23 stars

**Best multi-session UX in the entire ecosystem.**

Architecture: Go binary as CLI + Telegram bot. Uses tmux for persistence and
polling-based output capture (tmux capture-pane every 3 seconds).

Session model -- **Telegram Forum Topics**:
- Each Claude Code session gets its own Telegram forum topic within a group
- `/new myproject` creates: project dir + Telegram topic + tmux session + Claude
- Messages in a topic route to the corresponding tmux session
- `getSessionByTopic()` reverse-maps topic IDs to sessions
- Private chat messages go to one-shot Claude queries

Output capture (no hooks):
- Every 3 seconds, `tmux capture-pane` extracts last 500 lines per session
- Content hashing (first 100 chars) for deduplication
- **Edits existing messages** when block content changes
- **3-poll stability check** (9 seconds) before marking completion -- prevents
  premature "done" notifications
- Filters transient status messages

Interaction: `/new <name>`, `/continue`, `/c <cmd>`, `/update`, `/stats`,
`/auth`, `/delete`, `/cleanup`, `/list`. Voice messages via Whisper/Groq.

Unique features:
- Large file transfers via streaming relay (no server storage, files 50MB+)
- `ccc send ./file.apk` delivers build artifacts to the session's TG topic
- Seamless handoff: start on phone, `ccc` on PC attaches same tmux session

### 6. remote-agentic-coding-system (coleam00) -- TypeScript, Agent SDK + PostgreSQL -- 317 stars

Production-grade platform. Uses Agent SDK for Claude, Codex CLI for OpenAI.
PostgreSQL persistence, Docker Compose deployment.

Telegram adapter:
- Two streaming modes: `stream` (real-time editing) and `batch` (complete response)
- Message splitting at 4096 chars with line-based chunking
- Tool calls formatted as "wrench TOOLNAME" with brief context

Multi-platform: Telegram (Telegraf), GitHub webhooks, extensible adapter interface.
`/clone owner/repo` to work with any GitHub repository.

### 7. OpenClaw -- TypeScript, multi-channel gateway

Production-grade multi-channel assistant (Telegram, Discord, Slack, WhatsApp).
Uses grammY with long-polling.

Telegram-specific UX patterns:
- **Forum topics + DM threads**: per-topic sessions, config, system prompts
- **ACK emoji reactions**: bot reacts when processing starts, removes after reply
  (configurable scope: off, group-mentions, group-all, direct, all)
- **Draft streaming**: partial message updates while typing (DM-only, requires
  Threaded Mode on bot)
- **Message editing for navigation**: model browser uses edit-in-place, no spam
- **Text fragment buffering**: long pastes (>4000 chars) split across messages,
  bot reassembles (up to 12 parts, 50KB total, 1500ms timeout)
- **Media group batching**: multi-image messages grouped within ~300ms timeout

Authorization is CLI-based (pairing codes), not inline buttons.

### 8. claude-code-telegram (RichardAtCT) -- Python, CLI wrapper -- 267 stars

Telegram bot wrapping Claude Code CLI as subprocess. Per-project sessions.

- **Context-aware action buttons**: inline keyboards with "Run Tests", "Format
  Code", "Git Status" based on project context
- Terminal-like commands: `/ls`, `/cd`, `/pwd`, `/projects`
- Session export in Markdown, HTML, JSON
- SQLite persistence, usage analytics and cost tracking

### 9. claude-code-telegram-bot (errogaht) -- Node.js, CLI subprocess -- 4 stars

Most feature-rich single-session bot despite low star count.

Key UX patterns:
- **Persistent reply keyboard**: 12 always-visible buttons at bottom of chat
  (STOP, Status, Projects, New Session, Sessions, Model, Thinking, Path,
  Git Diff, Commands, Settings, Web App) -- no typing needed on mobile
- **Concat mode**: toggle on, type multiple messages, send as one batch
- **Web-based file browser** served over HTTP with syntax highlighting
- **22 built-in slash commands** including `/compact`, `/doctor`, `/cost`
- **Paginated command menus** (10 per page) with numbered selection buttons
- Voice message workflow: Transcription -> Execute/Cancel/Edit buttons
- Session history (up to 50) with browse/resume and token chain tracking

### 10. afk-code (clharman) -- 66 stars

Multi-platform (Telegram, Discord, Slack). Unix socket IPC.

Telegram limitation: one active session at a time, `/switch <name>` to change.
Discord/Slack support full multi-session with separate channels.
Auto-detects file paths in Claude output and uploads images.

### 11. Other notable projects

- **godagoo/claude-telegram-relay** (130 stars): Minimal `claude -p` subprocess
  relay. Platform daemons for auto-start. Scheduled briefings (morning summaries).
- **areweai/tsgram-mcp** (87 stars): MCP server approach -- Claude gets Telegram
  as a tool. Web dashboard at localhost:3000. Unique `:dangerzone` mode for editing.
- **Nickqiaoo/chatcode** (62 stars): Minimal Go vibe-coding bot.
- **seedprod/claude-code-telegram** (~100 lines): Minimal relay with skills system.

### Non-Telegram alternatives

- **Happy (happy.engineering)**: Free, open-source iOS/Android app with E2E
  encrypted relay. Multiple active sessions, voice-to-action, smart push.
- **CodeRemote (coderemote.dev)**: $49/mo CLI + Tailscale. Mobile web UI with
  gestures, live web app preview, code diff review.
- **claude-code-monitor** (170 stars): TUI + mobile web dashboard. Hook-based
  session discovery, QR code for mobile access.
- **Claude Code on the web** (code.claude.com): Anthropic's official web client.
  Sessions persist even if laptop is closed.

---

## The Four Paradigms

| Approach | Projects | Pros | Cons |
|----------|----------|------|------|
| **Hooks-only** | Us, Claude-Code-Remote, hanxiao | Real-time, event-driven, simple | Metadata-only, no message content |
| **JSONL polling** | ccbot, ccc | Full content, crash recovery, history | 2s latency, file format coupling |
| **Agent SDK** | linuz90, coleam00 | Full control, streaming, official API | Creates new instances, needs API key |
| **CLI wrapper** | RichardAtCT, errogaht | Simple, stateful | Not monitoring, per-message overhead |

---

## Multi-Session UX Patterns

This is the critical design question for Remote Claude. How do you monitor and
interact with 3-5 concurrent Claude Code sessions from a single Telegram bot?

### Pattern A: Forum Topics (one topic per session)

**Used by**: ccc, OpenClaw, ccbot

Each session gets its own Telegram forum topic within a group. Messages in a
topic route to that session. Telegram's native UI provides visual separation,
independent notification control, and scrollable per-session history.

| Pros | Cons |
|------|------|
| Zero interleaving -- each session is visually isolated | Requires a Group (not a DM) |
| Telegram handles the "dashboard" -- topic list IS the session list | More complex setup (create group, enable topics, add bot as admin) |
| Independent notifications per topic | Topic management overhead (create, close, archive) |
| Natural for mobile -- swipe between topics | Group may confuse users expecting a simple DM bot |
| Scales to many sessions without UI degradation | |

### Pattern B: Single Chat + Context Switching

**Used by**: Remote Claude v1, hanxiao, afk-code

All sessions share one DM chat. User switches context via commands (`/bind`,
`/switch`) or inline keyboard buttons. Notifications from all sessions
interleave chronologically.

| Pros | Cons |
|------|------|
| Simple setup (just DM the bot) | **Interleaved messages** -- the "confusing mess" |
| No Group management | Active session is invisible (hidden state) |
| Familiar bot interaction model | Permission buttons get buried under FYI messages |
| Works for 1-2 sessions | Breaks down at 3+ concurrent sessions |

### Pattern C: One Session Per Bot/Channel

**Used by**: linuz90, errogaht, RichardAtCT

Either one session at a time, or multiple bot instances for different projects.
Sidesteps multi-session entirely.

| Pros | Cons |
|------|------|
| No confusion about context | Doesn't scale |
| Simple implementation | Can't monitor concurrent work |

### Pattern D: Token-Scoped Session Linking

**Used by**: JessyTsui/Claude-Code-Remote

Each notification includes a 24-hour session token. Commands include the token:
`/cmd TOKEN123 your message`.

| Pros | Cons |
|------|------|
| Explicit session targeting | Clunky -- must copy-paste tokens |
| Works in single chat | Poor mobile UX (tiny tokens on phone keyboard) |

### Verdict

**No project has solved single-chat multi-session elegantly.** The bots that
handle multi-session well (ccc, OpenClaw, ccbot) all use forum topics. The
ones that stay in single-chat either support one session or have the same
interleaving problem.

---

## UX Tricks Catalog

Patterns worth incorporating regardless of architecture choice.

### Pinned Live-Status Message (server monitoring best practice)

One pinned message that the bot **edits** on every status change. Acts as an
always-visible dashboard without sending new messages. Only needs
`can_pin_messages` admin right.

```
Sessions (updated 11:30)

working  debug trace replay -- Bash (npm test)
idle     bot debug -- "Pushed 3 commits to origin/main"
idle     ai-mvp
```

### Silent vs Loud Notifications

Telegram API `disable_notification: true` suppresses vibration/sound.
- **Loud** (buzzes phone): permission requests, questions -- things needing action
- **Silent** (no buzz): session finished, went offline -- FYI only

Note: iOS suppresses silent notifications entirely; Android shows them visually.

### ACK Emoji Reactions (OpenClaw)

Bot reacts to user messages with an emoji when processing starts, removes after
reply. Instant feedback without a message. Configurable scope.

### Streaming Message Edits (linuz90, coleam00)

Create initial message, edit it repeatedly as content streams in. Tool use shown
as ephemeral messages that get deleted when the tool completes. Reduces chat
clutter dramatically.

### Persistent Reply Keyboard (errogaht)

Always-visible buttons at bottom of chat: Status, Sessions, Stop, etc. Reduces
typing on mobile. This is a **reply keyboard** (not inline), so it persists
across messages.

### Concat Mode (errogaht)

Toggle on, type multiple messages, send as one batch. Essential for composing
complex prompts on mobile where typing is slow and error-prone.

### Message Queuing with Interrupt (linuz90)

Send multiple messages while Claude works -- they queue automatically. Prefix
with `!` or `/stop` to interrupt current work and send immediately.

### Self-Cleaning Permission Buttons

After approve/reject, edit the message to a compact one-liner and remove buttons.
Prevents confusion from stale buttons sitting in chat history.

### 3-Poll Stability Check (ccc)

Wait for 3 consecutive identical output polls (9 seconds) before marking
"done". Prevents premature completion notifications when Claude is still
producing output.

### Pending-File Echo Prevention (hanxiao)

Only relay responses to Telegram if the message originated FROM Telegram.
Prevents echoing terminal-initiated conversations into the chat.

---

## Telegram Bot API Notes

### Formatting
- **HTML** (recommended): simpler, fewer escaping issues. Supports `<b>`, `<i>`,
  `<code>`, `<pre>`, `<a>`, `<blockquote>`, `<tg-spoiler>`, expandable blockquotes.
- **MarkdownV2**: powerful but painful -- must escape 18 special chars. Footgun.
- Only `<`, `>`, `&` need escaping in HTML mode.

### Message limits
- 4096 chars per text message
- 1024 chars for media captions
- 64 bytes per inline keyboard callback_data
- 30 messages/second per chat (bot API rate limit)
- 20 messages/minute per group (stricter)

### Key features for our use case
- `editMessageText` -- update sent messages in place (dashboards, tool results)
- `InlineKeyboardMarkup` -- buttons under messages (permissions, session picker)
- `ReplyKeyboardMarkup` -- persistent buttons at bottom of chat (quick actions)
- `message_thread_id` -- forum topic targeting
- `createForumTopic` -- programmatic topic creation
- `setMessageReaction` -- emoji ACK reactions
- `disable_notification` -- silent messages
- `pinChatMessage` -- pin dashboard message
- `sendChatAction("typing")` -- typing indicator
- Expandable blockquotes -- collapsible content for long outputs

### grammY vs Telegraf
- **grammY**: TypeScript-first, actively maintained, good types, plugin ecosystem.
  Used by OpenClaw. Supports long-polling and webhooks. Already our choice.
- **Telegraf**: Older, larger community, less TypeScript-friendly.

---

## References

- ccbot: https://github.com/six-ddc/ccbot
- Claude-Code-Remote: https://github.com/JessyTsui/Claude-Code-Remote
- claudecode-telegram: https://github.com/hanxiao/claudecode-telegram
- claude-telegram-bot: https://github.com/linuz90/claude-telegram-bot
- claude-code-telegram: https://github.com/RichardAtCT/claude-code-telegram
- ccc: https://github.com/kidandcat/ccc
- remote-agentic-coding-system: https://github.com/coleam00/remote-agentic-coding-system
- claude-code-telegram-bot: https://github.com/errogaht/claude-code-telegram-bot
- afk-code: https://github.com/clharman/afk-code
- OpenClaw: https://github.com/openclaw/openclaw
- tsgram-mcp: https://github.com/areweai/tsgram-mcp
- Happy: https://happy.engineering/
- Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview
- grammY: https://grammy.dev/
- Telegram Bot API: https://core.telegram.org/bots/api
