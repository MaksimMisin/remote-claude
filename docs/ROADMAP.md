# Remote Claude -- Roadmap

## Near-Term
- Service Worker for background push notifications
- Notification priority tiers (P0-P3) with distinct sounds
- Swipe-to-approve on permission cards
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
