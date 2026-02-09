# Telegram Integration -- Research & Prior Art

Survey of existing Claude Code + Telegram projects, what they do well, what they
don't, and what we should learn from them.

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
- File: `src/ccbot/transcript_parser.py` (entry parsing + formatting)
- File: `src/ccbot/session_monitor.py` (polling loop + byte offsets)
- File: `src/ccbot/handlers/message_sender.py` (MarkdownV2 + fallback)

### 2. Claude-Code-Remote (JessyTsui) -- Node.js, hooks-only

Hook-based (Stop + SubagentStop). Sends notifications on completion/waiting.
Supports email, Telegram, LINE, desktop. Telegram uses `/cmd TOKEN command`
pattern for sending prompts back.

What it does well:
- Multi-channel (email gets full terminal output, Telegram gets buttons)
- PTY mode (no tmux dependency) as default, tmux as fallback

What it lacks:
- Only fires on Stop/SubagentStop -- no real-time tool tracking
- Telegram interaction is clunky (token-based command format)
- No message content (just "task completed" / "waiting for input")

### 3. claudecode-telegram (hanxiao) -- Python, webhook + hooks

Stop hook reads transcript, sends response to Telegram via Bot API.
Telegram messages come in via Cloudflare tunnel to bridge server, injected
as tmux keystrokes. Uses "pending file" flag to only respond to
Telegram-initiated messages.

Simple and effective for one-shot interactions. Not designed for monitoring
multiple concurrent sessions.

### 4. claude-telegram-bot (linuz90) -- TypeScript, Agent SDK

Uses `@anthropic-ai/claude-agent-sdk` to spawn new Claude instances, not
monitor existing ones. Fundamentally different paradigm. Has custom `ask_user`
MCP tool that presents inline keyboard buttons. Supports text, voice, photos.

**Not applicable to our use case** (we monitor existing sessions, not create new
ones). But the `ask_user` inline keyboard pattern is worth noting.

### 5. claude-code-telegram (RichardAtCT) -- Python, wrapper

Telegram bot that runs `claude` CLI per-message. SQLite for session persistence.
Directory-scoped sessions. Rate limiting + sandboxing.

**Not applicable** (wrapper, not monitor).

### 6. OpenClaw -- TypeScript, multi-channel gateway

Production-grade multi-channel assistant. Telegram is one plugin among many
(Discord, Slack, WhatsApp, etc.). Uses grammY with long-polling. HTML formatting.
Agent-callable Telegram tools (send, edit, react, sticker). Per-group policies.

Relevant patterns:
- Plugin adapter architecture (could inspire future multi-channel for us)
- grammY as the Telegram framework (TypeScript, type-safe, well-maintained)
- Markdown -> HTML conversion (Telegram HTML is simpler than MarkdownV2)
- 4000-char chunk limit (they use HTML, not MarkdownV2)
- Fallback to plain text on parse errors
- Long-polling default (simpler than webhooks, no tunnel needed)

---

## The Four Paradigms

| Approach | Projects | Pros | Cons |
|----------|----------|------|------|
| **Hooks-only** | Us, Claude-Code-Remote, hanxiao | Real-time, event-driven, simple | Metadata-only, no message content |
| **JSONL polling** | ccbot | Full content, crash recovery, history | 2s latency, file format coupling |
| **Agent SDK** | linuz90 | Full control, streaming, official API | Creates new instances, needs API key |
| **CLI wrapper** | RichardAtCT | Simple, stateful | Not monitoring, per-message overhead |

---

## Key Insight: Hybrid is the Right Answer

Neither hooks-only nor JSONL-only is sufficient alone:

**Hooks give us** (and only hooks can give us):
- Instant status transitions (milliseconds, not 2 seconds)
- Structured event metadata (tool name, input, git context, tokens)
- Permission prompt detection via Notification hook
- Session auto-discovery from any event type

**JSONL polling gives us** (and only JSONL can give us):
- Full assistant text (not truncated to 4KB)
- Complete tool results (stdout, diffs, search results)
- Thinking blocks
- Message history for crash recovery
- Tool use/result pairing across time

The hybrid:
```
Hooks (instant)  -->  Status transitions, permission alerts, session discovery
JSONL poll (2s)  -->  Full message content for Telegram delivery
Both combined    -->  Rich, real-time Telegram experience
```

---

## Telegram Bot API Notes

### Formatting options
- **MarkdownV2**: what ccbot uses. Powerful but painful -- must escape 18 special
  chars (`_*[]()~>#+\-=|{}.!`). The `telegramify-markdown` library helps but adds
  a Python dependency. No direct JS equivalent with same quality.
- **HTML**: what OpenClaw uses. Simpler, fewer escaping issues. Supports
  `<b>`, `<i>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`, `<tg-spoiler>`.
  Expandable blockquotes: `<blockquote expandable>...</blockquote>`.
- **Recommendation**: Use HTML. Simpler to generate, fewer edge cases, expandable
  blockquotes work the same way. MarkdownV2 is a footgun.

### Message limits
- 4096 chars per message (text)
- 1024 chars for caption (media messages)
- Inline keyboard: 64 bytes per callback_data
- 30 messages/second to same chat (bot API rate limit)
- 20 messages/minute to same group (stricter)

### Useful features
- `editMessageText` -- edit a sent message (for tool result updates)
- `InlineKeyboardMarkup` -- buttons under messages (for permissions, navigation)
- `message_thread_id` -- forum topic support (if we go topic-per-session)
- `parse_mode: "HTML"` -- formatting
- `disable_web_page_preview: true` -- suppress link previews
- `sendChatAction("typing")` -- typing indicator
- `expandable blockquote` -- collapsible content (thinking, long outputs)

### grammY vs Telegraf
- **grammY**: TypeScript-first, actively maintained, good types, plugin ecosystem.
  Used by OpenClaw. Supports long-polling and webhooks. Recommended.
- **Telegraf**: Older, larger community, but less TypeScript-friendly. v4 is fine
  but grammY is the modern choice.

---

## References

- ccbot: https://github.com/six-ddc/ccbot
- Claude-Code-Remote: https://github.com/JessyTsui/Claude-Code-Remote
- claudecode-telegram: https://github.com/hanxiao/claudecode-telegram
- claude-telegram-bot: https://github.com/linuz90/claude-telegram-bot
- claude-code-telegram: https://github.com/RichardAtCT/claude-code-telegram
- OpenClaw: https://github.com/openclaw/openclaw
- Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview
- grammY: https://grammy.dev/
- Telegram Bot API: https://core.telegram.org/bots/api
- HN discussion: https://news.ycombinator.com/item?id=46563672
