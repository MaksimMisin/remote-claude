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

## Near-Term
- Notification priority tiers (P0-P3) with distinct sounds
- Swipe-to-approve on permission cards (currently swipe = close/dismiss)
- Session detail view with full history

## Medium-Term
- Bottom tab navigation (Sessions / Activity / Settings)
- Activity tab (cross-session feed)
- Settings screen
- Quick Action Overlay (bottom sheet)
- Notification grouping

## Long-Term / Aspirational
- Voice: TTS status announcements (Web Speech API)
- Voice: STT for hands-free input
- iOS Live Activity / Dynamic Island
- PWA enhancements (Badge, Wake Lock, MediaSession)
- Accessibility audit
- Multi-user support

## Decided Against
- Preact (chose React), Zustand (hooks sufficient)
- Transcript fallback for markers (markers-only works)
- Database (JSONL + JSON sufficient)
- Code editor / terminal emulator on phone
- Synthetic prompt events from server (caused duplicates with hook events)
