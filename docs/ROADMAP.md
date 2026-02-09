# Remote Claude -- Roadmap

## Completed
- Web Push notifications via service worker (VAPID, reliable Android background delivery)
- 4-mode notification cycle (off / silent / vibrate / full)
- Image upload in prompts (single and multiple)
- Prompt queue (auto-send when session becomes idle)
- Session rename, dismiss, close
- Swipe gestures with confirmation dialogs
- Slash command output capture via tmux pane diffing
- Git branch + dirty state tracking
- Token usage tracking
- Inline expandable diffs, command previews, plan content in event feed
- Permission prompt UI inline on session cards (Yes / Allow All / No)
- Cloudflare Tunnel + Access for internet exposure

## Next: Telegram Bot Integration

Reliable mobile notifications and two-way control via Telegram, bypassing
Android/Samsung battery optimization that kills Web Push delivery.

**Why:** Web Push ~33% deliverability on Samsung (Deep Sleep kills browser
process). Telegram uses FCM directly, never deep-slept, ~95%+ delivery.

**Approach: Hybrid (hooks + JSONL transcript polling)**
- **Hooks** (existing): real-time status transitions, permission prompts, instant alerts
- **JSONL transcript polling** (new): full message content for rich Telegram messages
- **tmux keystroke injection** (existing): prompt delivery from Telegram

This follows ccbot's proven architecture (JSONL polling for content) while keeping
our real-time hook advantages. See `docs/telegram/` for detailed design.

**v1 scope:**
- grammY bot in `server/TelegramBot.ts`, long-polling (no webhook infra needed)
- Status notifications on transitions: working→idle, working→waiting, errors
- Rich messages: Claude's responses, tool summaries, expandable thinking
- Inline keyboard for permission approve/reject
- Send prompts from Telegram, routed to correct session
- 1 chat = 1 user (single-user, DM mode). Topic-per-session or flat chat TBD.
- `/sessions`, `/status` commands

**v1 non-goals:** Multi-user, image upload via Telegram, session creation from
Telegram, full ccbot-level message editing, transcript history browsing.

**Prior art:** See `docs/telegram/RESEARCH.md` and `related-code/ccbot/`.

## Long-Term / Aspirational
- JSONL content in web dashboard (enriched event feed with tool outputs)
- Telegram: topic-per-session (forum mode), screenshot command, history browsing
- Voice: TTS status announcements (Web Speech API)
- Voice: STT for hands-free input
- PWA enhancements (Badge, Wake Lock, MediaSession)

## Decided Against
- Preact (chose React), Zustand (hooks sufficient)
- Transcript fallback for markers (markers-only works)
- Database (JSONL + JSON sufficient)
- Code editor / terminal emulator on phone
- Synthetic prompt events from server (caused duplicates with hook events)
- Agent SDK approach (creates new Claude instances, doesn't monitor existing ones)
- Hooks-only Telegram (metadata-only, can't show Claude's actual responses/outputs)
