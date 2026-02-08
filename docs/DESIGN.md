# Remote Claude -- Mobile UX Design Document

## Design Philosophy

The core user scenario: a developer has 3-6 Claude Code sessions running in tmux on
their Mac. They are doing dishes, folding laundry, or walking around the house. Their
phone is propped on the counter or in their pocket. They need to:

1. Know when something needs their attention (voice announcement or vibration)
2. Understand what happened in 2 seconds of glancing at the screen
3. Act on it -- approve, reject, answer -- with one thumb in under 5 seconds
4. Optionally dive deeper if the decision requires context

**The "doing dishes" test**: every design decision must pass this filter -- can the user
interact with wet/busy hands, poor attention, and a phone 3 feet away?

The answer is a voice-first, notification-driven interface with a card-based dashboard
for visual monitoring.

---

## Implementation Status

This document is the design north star. Not everything is built yet.

| Section | Status | Notes |
|---------|--------|-------|
| Information Architecture | Partial | Single-page dashboard, no tab bar or URL routing |
| Session Card Design | Implemented | Cards, state dots, priority ordering, swipe close/dismiss |
| Notification UX | Partial | Service worker notifications (Android+desktop), 4-mode cycle (off/silent/vibrate/full), no P0-P3 tiers or grouping |
| Quick-Action Flows | Partial | Permission UI inline on cards, not bottom sheet overlay |
| Voice Interaction | Not started | No TTS or STT |
| Gesture Shortcuts | Partial | Swipe on cards for close/dismiss, no swipe-to-approve |
| State Machine | Implemented | 4 states (idle/working/waiting/offline) |
| Progressive Disclosure | Partial | Glance + interact tiers, no deep dive view |
| Mobile-Specific | Partial | Dark theme, thumb zone, PWA manifest. No Live Activity |
| Accessibility | Partial | Touch targets, reduced motion. No ARIA audit |
| Performance Budgets | Not measured | No formal testing |
| Technology | Diverged | React (not Preact), hooks-based state (not Zustand) |

Features added beyond this design: image uploads, session creation modal with flag
toggles, git branch/dirty tracking, token counting, prompt queueing, Cloudflare
Tunnel internet exposure, session dismiss/close, service worker for Android
notifications, 4-mode notification cycle (off/silent/vibrate/full) with localStorage
persistence, long-press bell icon to test notifications.

---

## 1. Information Architecture

### Screen Hierarchy

```
Lock Screen / Notifications
    |
    v
Dashboard (all sessions)
    |
    v
Session Detail (one session, full history)
    |
    v
Quick Action Overlay (approve/reject/respond)
```

### Navigation Model

Bottom tab bar with 3 tabs, all in the thumb zone:

| Tab        | Purpose                    | Badge          |
|------------|----------------------------|----------------|
| Sessions   | Dashboard with all cards    | Count needing attention |
| Activity   | Unified feed, all sessions  | Unread count   |
| Settings   | Voice, notifications, server| --             |

The Sessions tab is the primary view. The Activity tab provides a chronological
feed for deep dives. Settings is rarely visited.

There is no hamburger menu. There are no hidden navigation elements. Everything is
reachable in 1-2 taps from the dashboard.

### URL Structure (PWA)

```
/                    -> Dashboard (redirect)
/sessions            -> Dashboard
/sessions/:id        -> Session detail
/sessions/:id/action -> Quick action overlay (deep link from notification)
/activity            -> Unified activity feed
/settings            -> Settings
```

---

## 2. Session Card Design

Each session is represented by a card on the dashboard. Cards are the atomic unit of
the interface. They must communicate state at a glance from arm's length.

### Card Anatomy

```
+--------------------------------------------------+
|  [STATE DOT]  Session Name             [2m ago]   |
|                                                    |
|  Current action summary (1 line, truncated)        |
|                                                    |
|  [progress indicator or action buttons]            |
+--------------------------------------------------+
```

### Card Elements

**State Dot** (left edge, large, 12px diameter):
- Green, pulsing slowly: working (all is well, Claude is busy)
- Amber, pulsing fast: waiting for input (needs attention soon)
- Red, solid: error or blocked (needs attention now)
- Blue, static: idle / finished (review when convenient)
- Gray, static: offline

The dot is the single most important visual element. Its color and animation must be
readable at arm's length on a phone screen.

**Session Name**: User-assigned label. "Frontend", "Tests", "API Refactor". Bold,
16px minimum. This is the identifier the user has in their mental model.
Tapping the name to rename is ONLY available when the session card is expanded
(selected). On the dashboard list view, tapping the name selects the card instead
-- rename on the dashboard is a nuisance that interferes with card selection.

**Timestamp**: Relative time since last activity. "just now", "2m ago", "15m ago".
Updates live.

**Action Summary** (1 line, 60 chars max):
- Working: "Editing src/auth/handler.ts" or "Running npm test"
- Waiting: "Asking: Should I refactor the auth module?"
- Error: "Bash failed: exit code 1 (npm test)"
- Idle: "Finished -- 12 files changed, all tests pass"
- Offline: "Session disconnected"

This line uses the tool events from Vibecraft's type system:
- `pre_tool_use` with `tool: 'Edit'` -> "Editing {file_path}"
- `pre_tool_use` with `tool: 'Bash'` -> "Running {command}" (truncated)
- `notification` with `notificationType: 'permission_prompt'` -> "Asking permission: {tool}"
- `stop` event -> "Finished -- {summary}"

**Progress Indicator / Action Buttons** (bottom area):
- Working: Thin animated progress bar (indeterminate, subtle)
- Waiting for input: Action buttons (e.g., [Approve] [Reject] [View])
- Error: [View Error] [Retry] buttons
- Idle/Finished: Hidden (no action needed, card is compact)

### Card Sizing

Cards span full width minus 16px margin on each side. Stack vertically with 8px gaps.
No horizontal scrolling. No grid layout -- on a phone, single column is the only layout
that works for one-handed thumb scrolling.

When a session needs attention, its card expands slightly to reveal inline action
buttons. When it does not need attention, the card is compact (3 lines tall).

### Card Ordering

Cards are sorted by priority, not creation order:

1. Waiting for input (amber/red) -- sorted by wait time (longest first)
2. Working (green) -- sorted by last activity (most recent first)
3. Idle/Finished (blue) -- sorted by finish time (most recent first)
4. Offline (gray) -- always at bottom

This means the card the user most needs to deal with is always at the top,
reachable without scrolling.

---

## 3. Notification UX

Notifications are the primary interaction channel for the "doing dishes" user. They
must be precise, actionable, and stratified by urgency.

### Priority Levels

| Priority | Trigger | Visual | Sound | Vibration | TTS |
|----------|---------|--------|-------|-----------|-----|
| P0 Critical | Error blocking all sessions, server disconnect | Red banner, persistent | Alarm tone | 3x long burst | Yes, immediate |
| P1 Action Required | Permission prompt, question, plan approval | Amber banner, sticky | Notification chime | 2x short burst | Yes, after 3s delay |
| P2 Attention | Session finished, test results ready | Blue banner, auto-dismiss 10s | Soft ping | 1x short | Yes, if voice mode on |
| P3 Info | Session started working, tool completed | No banner (in-app feed only) | None | None | No |

### Push Notification Format

Push notifications must be actionable without opening the app.

**P1 -- Permission Prompt:**
```
Remote Claude -- Frontend
"Allow Edit on src/auth/handler.ts?"
[Approve]  [Reject]  [View Details]
```

**P1 -- Question:**
```
Remote Claude -- API Refactor
"Should I use Redis or PostgreSQL for session storage?"
[Answer...]  [View Context]
```

**P2 -- Session Finished:**
```
Remote Claude -- Tests
"Finished: 12 files changed, 47 tests passing"
[View]  [Dismiss]
```

### In-App Notification Banner

When the app is in the foreground, notifications appear as a banner that slides down
from the top of the screen. The banner is 72px tall (large enough to tap), contains the
session name, summary, and up to 2 action buttons.

Banners for P1 notifications are "sticky" -- they remain until the user acts on them or
dismisses with a swipe. They stack (max 3 visible, then "+N more" indicator). Tapping
the banner navigates to the quick action overlay for that session.

### Notification Grouping

If multiple sessions finish within a 30-second window, group them:

```
Remote Claude
"3 sessions finished and need review"
[View All]
```

This prevents notification fatigue when running parallel sessions.

### Sound Design

| Event | Sound | Duration | Character |
|-------|-------|----------|-----------|
| Permission/Question | Two-tone rising chime (D4 -> A4) | 400ms | Urgent but not alarming |
| Session finished | Single soft bell (C5) | 300ms | Gentle completion |
| Error | Low descending tone (A3 -> E3) | 500ms | Unmistakably "something went wrong" |
| Server disconnect | Repeating low pulse (E2, 3x) | 1500ms | Persistent alert |

Sounds should be distinct enough to identify the event type without looking at the
phone. The user doing dishes hears the two-tone chime and knows "a session is asking
me something" vs. the soft bell "something finished."

### Do Not Disturb Integration

Respect system DND settings. When DND is active:
- P0: Still vibrate (no sound, no TTS)
- P1: Silent push notification only (no sound, no vibration)
- P2-P3: Suppressed entirely, queued for when DND ends

---

## 4. Interaction Patterns

### 4a. Quick-Action Flows

The fastest possible path from notification to resolution.

**Permission Approval (target: 2 taps, under 3 seconds):**

```
Notification arrives -> Tap notification -> Quick Action Overlay
                                                |
                                          [Approve] [Reject]
                                                |
                                          Tap Approve -> Done (overlay closes)
```

The quick action overlay is a bottom sheet that slides up over the current view.
It contains:
- Session name and state dot (top, small)
- The question/permission context (middle, 2-4 lines max)
- Action buttons (bottom, large, in thumb zone)

**Question Response (target: under 10 seconds):**

```
Notification -> Tap -> Quick Action Overlay
                            |
                      Question text
                      [Option A] [Option B] [Custom...]
                            |
                      Tap option -> Done
                      -- or --
                      Tap Custom -> Keyboard/Voice input -> Send -> Done
```

For custom responses, the input field appears above the keyboard with a prominent
microphone button for voice dictation (STT). Voice is the preferred input method
for the hands-busy user.

**Plan Review (target: under 30 seconds for simple, unlimited for complex):**

```
Notification -> Tap -> Quick Action Overlay
                            |
                      Plan summary (collapsed, 3 lines)
                      [Approve] [Reject] [Read Full Plan]
                            |
                      Tap "Read Full Plan" -> Session Detail view
```

Most plan approvals do not require reading the full plan. The summary line in the
quick action overlay shows: "Edit 3 files, add auth middleware, update 2 tests."
If the user trusts the session, they tap Approve. If they want details, one more
tap gets them the full plan in the session detail view.

### 4b. Voice Interaction Flow

Voice is the primary channel when the user's hands are busy.

**TTS (System speaks to user):**

TTS is triggered by P1 and P2 events when voice mode is enabled. The flow:

1. Event arrives (permission prompt, question, session finished)
2. System waits 1 second (debounce -- avoid interrupting rapid events)
3. A short chime plays (200ms, to get attention)
4. TTS reads a concise summary:
   - Permission: "Frontend is asking to edit auth handler dot ts. Approve or reject?"
   - Question: "API Refactor is asking: should I use Redis or Postgres for sessions?"
   - Finished: "Tests session finished. 47 tests passing."
5. After TTS completes, the system enters a 5-second "listening window" if the
   event requires a response (P1 only)

**STT (User speaks to system):**

Two modes of voice input:

**Passive listening (after TTS prompt):**
After the system reads a P1 notification aloud, it opens a 5-second listening window.
The user can say:
- "Approve" / "Yes" / "Allow" -> Approves the permission/plan
- "Reject" / "No" / "Deny" -> Rejects
- "Skip" / "Later" -> Dismisses, keeps in queue
- Any other phrase -> Sent as a text response to the question

If the user says nothing within 5 seconds, the listening window closes silently. The
notification remains in the queue.

A visual indicator on the phone shows the listening state: a pulsing microphone icon
at the bottom of the screen with a circular timer showing the remaining window.

**Active dictation (user initiates):**
The user taps the microphone button (or says a wake phrase if configured) to start
dictating a longer response. The dictation continues until the user taps stop or
pauses for 2 seconds.

**Voice Interaction State Machine:**

```
SILENT ----[P1 event]----> TTS_PLAYING ----[TTS done]----> LISTENING
  ^                                                             |
  |                            [5s timeout or response]         |
  +-------------------------------------------------------------+
```

**TTS Content Rules:**
- Never read code aloud. Summarize: "editing 3 files" not the file contents.
- Keep TTS under 15 seconds. If the context is longer, read the headline and say
  "check your phone for details."
- Use natural phrasing: "Frontend wants to run npm test" not "pre tool use bash
  npm test."
- Session names are spoken as the user-assigned labels, not IDs.

### 4c. Gesture-Based Shortcuts

| Gesture | Context | Action |
|---------|---------|--------|
| Swipe right on card | Dashboard | Quick approve (if session is waiting for permission) |
| Swipe left on card | Dashboard | Dismiss / mark as reviewed |
| Long press on card | Dashboard | Open session detail view |
| Pull down | Dashboard | Refresh session status |
| Swipe down on banner | Notification banner | Dismiss notification |
| Swipe up on banner | Notification banner | Open quick action overlay |
| Double tap anywhere | Quick action overlay | Approve / confirm (primary action) |
| Shake phone | Anywhere | Toggle voice mode on/off |

Swipe-to-approve is the killer gesture. The user sees the amber card, swipes right
with their thumb, and the permission is approved. One gesture, zero taps on buttons.

Visual feedback for swipe: as the card moves right, a green "Approve" label is
revealed underneath (like iOS Mail's swipe-to-archive). If the card moves left, a
gray "Dismiss" label appears.

Haptic feedback: a single tap on swipe threshold confirmation.

---

## 5. State Machine

Each session card displays one of 5 visual states. States are derived from the event
stream using the same logic as Vibecraft's `SessionStatus` plus additional granularity
for the mobile context.

### States

```
                    +---[user_prompt_submit]---+
                    |                          |
                    v                          |
              +-----------+                    |
         +--->|  WORKING  |----[stop]----> +--------+
         |    +-----------+                |  IDLE   |
         |         |                       +--------+
         |    [notification:                    |
         |     permission_prompt /              |
         |     idle_prompt /            [session_end]
         |     elicitation_dialog]              |
         |         |                            v
         |         v                      +-----------+
         |    +-----------+               | FINISHED  |
         |    |  WAITING  |               +-----------+
         |    +-----------+
         |         |
         |    [user responds]
         |         |
         +----<----+


   Any state ---[tmux dies / health check fail]---> OFFLINE
   OFFLINE ---[tmux reconnect / health restored]---> IDLE
   Any state ---[error event]---> ERROR
   ERROR ---[user acknowledges / retry]---> WORKING or IDLE
```

### State Display Properties

| State    | Dot Color | Dot Animation    | Card BG     | Sound on Enter | TTS on Enter |
|----------|-----------|------------------|-------------|----------------|--------------|
| WORKING  | Green     | Slow pulse (2s)  | Default     | None           | None         |
| WAITING  | Amber     | Fast pulse (0.5s)| Light amber | Chime          | Yes (P1)     |
| ERROR    | Red       | Solid (no pulse) | Light red   | Error tone     | Yes (P0/P1)  |
| IDLE     | Blue      | None (static)    | Default     | Soft ping      | Optional     |
| FINISHED | Blue      | None (static)    | Light blue  | Soft ping      | Optional     |
| OFFLINE  | Gray      | None (static)    | Dimmed      | None           | None         |

Note: IDLE and FINISHED are visually similar but semantically different. IDLE means
Claude is at a prompt waiting for user input. FINISHED means Claude completed a task
and the user should review the result. The distinction matters for notification
priority: FINISHED triggers a P2 notification, IDLE does not.

### State Derivation from Events

```typescript
function deriveState(session: ManagedSession, lastEvent: ClaudeEvent): SessionVisualState {
  if (session.status === 'offline') return 'OFFLINE';

  if (lastEvent.type === 'notification') {
    const n = lastEvent as NotificationEvent;
    if (['permission_prompt', 'idle_prompt', 'elicitation_dialog'].includes(n.notificationType)) {
      return 'WAITING';
    }
  }

  if (lastEvent.type === 'post_tool_use' && !(lastEvent as PostToolUseEvent).success) {
    return 'ERROR';
  }

  if (lastEvent.type === 'stop') return 'FINISHED';
  if (lastEvent.type === 'session_end') return 'FINISHED';

  if (session.status === 'working') return 'WORKING';

  return 'IDLE';
}
```

---

## 6. Progressive Disclosure

Information is layered in 4 tiers. Each tier requires a deliberate action to reach,
ensuring the user is never overwhelmed but can always go deeper.

### Tier 0: Ambient (no screen interaction)

What the user perceives without touching or looking at the phone.

- **TTS announcements**: "Frontend wants to edit auth handler. Approve?"
- **Sound patterns**: Chime = question, bell = finished, buzz = error
- **Vibration patterns**: Encoded by priority (see Notification UX section)
- **Lock screen badge**: App icon shows count of sessions needing attention

This tier serves the "phone in pocket while doing dishes" scenario.

### Tier 1: Glance (look at phone for 2 seconds)

What the user sees when they glance at the lock screen or the dashboard.

- **Lock screen notifications**: Session name + one-line summary + action buttons
- **Dashboard cards**: State dot (color) + session name + action summary
- **Attention count**: Badge on Sessions tab showing how many need attention

Card ordering ensures the most important items are visible without scrolling.
The state dot color is readable at arm's length.

At this tier, the user can answer: "Do any sessions need me right now?" and
"Which one?" without reading any text -- just by scanning dot colors.

### Tier 2: Interact (tap to act, 5-15 seconds)

What the user gets when they tap a card or notification.

- **Quick Action Overlay**: The question/permission in context, with action buttons
- **Expanded card**: The action summary expands to 2-3 lines with more detail
- **Inline actions**: Approve/reject buttons, option selection, text/voice input

At this tier, the user can resolve most P1 notifications. The overlay shows just
enough context to make a decision: what tool, what file, what the options are.

### Tier 3: Deep Dive (scroll, read, 30+ seconds)

What the user gets when they need full context.

- **Session Detail View**: Complete event history for one session
- **File diffs**: Inline display of what was changed (syntax highlighted)
- **Bash output**: Collapsed by default, expandable
- **Full conversation**: The back-and-forth between user and Claude

This tier is for when the user needs to understand what happened before making
a decision. It is the "sit down and look at the phone properly" scenario.

### Transition Triggers

| From | To | Trigger |
|------|-----|---------|
| Tier 0 | Tier 1 | Pick up phone / glance at screen |
| Tier 1 | Tier 2 | Tap card or notification |
| Tier 2 | Tier 3 | Tap "View Details" or "Read Full Plan" |
| Tier 2 | Tier 0 | Tap action button (approve/reject) -> auto-close |
| Tier 3 | Tier 1 | Back button or swipe back |

The key insight: Tier 0 -> Tier 2 is the most common flow. The user hears a TTS
announcement, picks up the phone, taps the notification, and acts. Tier 1 (the
dashboard) is often skipped entirely when responding to a specific notification.

---

## 7. Mobile-Specific Considerations

### Thumb Zone Layout

On a standard phone (375pt width), the thumb zone for one-handed use (right hand)
covers roughly the bottom-right 60% of the screen. Key placement decisions:

```
+----------------------------------+
|                                  |  <- Hard to reach (status bar area)
|   Session name, status info      |  <- OK for reading, not for tapping
|                                  |
|   Card content area              |  <- Comfortable viewing zone
|                                  |
|   [Action Button] [Action Button]|  <- Prime thumb zone
|                                  |
|   [Sessions]  [Activity]  [Gear] |  <- Bottom nav (easiest reach)
+----------------------------------+
```

Rules:
- All tappable elements are minimum 44x44pt (iOS) / 48x48dp (Android)
- Primary action buttons are in the bottom third of the screen
- The quick action overlay anchors to the bottom, so buttons are in the thumb zone
- No important tap targets in the top-left corner (hardest to reach one-handed)
- Navigation is always at the bottom, never at the top

### One-Handed Use Optimizations

- **Bottom sheet for all overlays**: Quick actions, session detail, settings all
  slide up from the bottom. The user's thumb is already there.
- **Swipe gestures on cards**: Avoid requiring the user to tap small buttons when
  a broad swipe will do.
- **No pinch/zoom**: Content reflows to fit the screen. No need for two-handed
  gestures.
- **Pull-to-refresh at top**: This is acceptable because it is an infrequent
  action, not a critical flow.

### Lock Screen / Always-On Display

**iOS Live Activity (high value):**

A Live Activity on the lock screen showing the aggregate status of all sessions:

```
+------------------------------------------+
|  Remote Claude          3 working, 1 wait |
|  [***]  Frontend -- editing auth.ts       |
|  [!]    Tests -- "Run integration tests?" |
+------------------------------------------+
```

The Live Activity updates in real time via push notifications. It shows:
- Total session count and aggregate status
- The most urgent session (waiting > error > working > idle)
- A one-line summary of what that session needs

Tapping the Live Activity opens the app directly to the relevant session's
quick action overlay.

**iOS Dynamic Island (compact):**

When a session transitions to WAITING, the Dynamic Island shows:

Compact: `[!] Frontend`
Expanded:
```
+------------------------------------------+
|  Frontend -- waiting for input            |
|  "Allow Edit on auth/handler.ts?"         |
|  [Approve]                      [Reject]  |
+------------------------------------------+
```

The Dynamic Island is the ultimate glanceable interface. It persists until
the user acts, serving as a constant reminder that a session needs attention.

**Android Ongoing Notification:**

Equivalent to Live Activity. A persistent notification in the shade that shows
aggregate status and the most urgent item. Action buttons for the top-priority
session are embedded in the notification.

Note: iOS Live Activity, Dynamic Island, and Android ongoing notifications require
a native wrapper app (not achievable in a PWA alone). These are stretch goals that
would require a thin native shell (e.g., Capacitor or a native Swift/Kotlin app)
wrapping the web view. The core PWA experience works without these features.

### PWA Considerations

Remote Claude is a web app accessed via the phone's browser. PWA capabilities
to leverage:

- **Add to Home Screen**: Full-screen mode, no browser chrome
- **Web Push Notifications**: For P0-P2 alerts when app is backgrounded
- **Service Worker**: Cache the app shell for instant loading
- **Badge API**: Show attention count on the home screen icon
- **Wake Lock API**: Keep screen on during active voice interaction
- **Vibration API**: For haptic patterns on notification receipt
- **Web Speech API**: For STT (speech recognition) in the browser
- **MediaSession API**: For controlling TTS playback from lock screen

Limitations to account for:
- No true Live Activity / Dynamic Island access from PWA (native wrapper
  would be needed for this)
- Push notification delivery can be delayed on iOS for PWAs
- Background execution is limited -- the server must push state, not the
  client polling

### Screen Wake and Attention

When a P0 or P1 notification arrives:
- If the screen is off, the notification wakes the screen for 10 seconds
  (via Web Notifications API with `requireInteraction: true`)
- If the app is in the background, the push notification is delivered
  with maximum priority
- If the app is in the foreground, the banner slides in with sound/vibration

### Network Resilience

The user is walking around the house. WiFi might drop briefly.

- **WebSocket with auto-reconnect**: Exponential backoff (1s, 2s, 4s, max 30s)
- **Optimistic UI**: Actions (approve/reject) show success immediately, retry
  in background if the connection was lost
- **Offline queue**: Actions taken while offline are queued and replayed on
  reconnect
- **Connection indicator**: Small dot in the header (green = connected,
  yellow = reconnecting, red = disconnected). Unobtrusive but visible.
- **Stale data warning**: If disconnected for >30 seconds, show a subtle
  banner: "Reconnecting... data may be stale"

---

## 8. ASCII Wireframes

### 8a. Dashboard View (All Sessions)

Default view when opening the app. Shows all sessions sorted by priority.

```
+------------------------------------------+
|  Remote Claude            [mic] [wifi:*]  |
|                                           |
|  2 need attention                         |
|                                           |
| +--------------------------------------+  |
| | (*) Frontend                   3m    |  |
| |     Asking: "Refactor auth module?"  |  |
| |     [Approve]  [Reject]  [View]      |  |
| +--------------------------------------+  |
|                                           |
| +--------------------------------------+  |
| | (!) Tests                      1m    |  |
| |     Error: npm test exit code 1      |  |
| |     [View Error]  [Retry]            |  |
| +--------------------------------------+  |
|                                           |
| +--------------------------------------+  |
| | (o) API Refactor               12s   |  |
| |     Editing src/routes/sessions.ts   |  |
| |     ================================ |  |
| +--------------------------------------+  |
|                                           |
| +--------------------------------------+  |
| | (-) Docs                       5m    |  |
| |     Finished -- 3 files updated      |  |
| +--------------------------------------+  |
|                                           |
|  [Sessions]    [Activity]     [Settings]  |
+------------------------------------------+

Legend:
  (*) = Amber dot, pulsing (WAITING)
  (!) = Red dot, solid (ERROR)
  (o) = Green dot, slow pulse (WORKING)
  (-) = Blue dot, static (FINISHED)
  ===== = Indeterminate progress bar
  [wifi:*] = Connected indicator
  [mic] = Voice mode toggle
```

### 8b. Session Detail View

Full history for a single session. Reached by long-pressing a card or tapping
"View Details."

```
+------------------------------------------+
|  [<Back]   Frontend          [mic] [...]  |
|                                           |
|  Status: WAITING           Duration: 14m  |
|  Branch: feature/auth      +12 -3 files   |
|                                           |
|  +--------------------------------------+ |
|  | CURRENT -- Permission Request        | |
|  |                                      | |
|  | Claude wants to edit:                | |
|  | src/auth/handler.ts                  | |
|  |                                      | |
|  | Changes:                             | |
|  | + import { verify } from 'jsonw...'  | |
|  | + const token = req.headers.auth...  | |
|  | [Show full diff]                     | |
|  |                                      | |
|  | [  Approve  ]    [  Reject  ]        | |
|  +--------------------------------------+ |
|                                           |
|  --- Event History (newest first) ---     |
|                                           |
|  14:03  Bash: npm install jsonwebtoken    |
|         exit 0 (2.3s)                     |
|                                           |
|  14:02  Edit: src/auth/middleware.ts       |
|         +24 lines, -3 lines              |
|         [Show diff]                       |
|                                           |
|  14:01  Read: src/auth/handler.ts         |
|         142 lines                         |
|                                           |
|  14:00  Read: package.json                |
|         [Show contents]                   |
|                                           |
|  13:59  User: "Add JWT auth to the API"   |
|                                           |
|  [Sessions]    [Activity]     [Settings]  |
+------------------------------------------+
```

### 8c. Quick Action Overlay

Bottom sheet that appears over the dashboard when a notification is tapped
or a card action is triggered. Anchored to the bottom for thumb access.

```
+------------------------------------------+
|                                           |
|  (dimmed dashboard behind)                |
|                                           |
|                                           |
+~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~+
|                                           |
|  [---]  (drag handle)                     |
|                                           |
|  (*) Frontend -- Waiting for approval     |
|                                           |
|  Claude wants to edit                     |
|  src/auth/handler.ts                      |
|                                           |
|  "Adding JWT verification middleware      |
|   to protect the /api/sessions endpoint"  |
|                                           |
|  +------+  +------+  +--------------+     |
|  |Approve|  |Reject|  | View Details |     |
|  +------+  +------+  +--------------+     |
|                                           |
+------------------------------------------+

(Approve and Reject buttons are large, 48pt tall,
 in the bottom third -- prime thumb zone)
```

**For questions requiring text input:**

```
+~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~+
|                                           |
|  [---]  (drag handle)                     |
|                                           |
|  (*) API Refactor -- Question             |
|                                           |
|  "Should I use Redis or PostgreSQL        |
|   for the session storage backend?"       |
|                                           |
|  +------------------+  +---------------+  |
|  | Redis            |  | PostgreSQL    |  |
|  +------------------+  +---------------+  |
|                                           |
|  +--------------------------------------+ |
|  | Type or dictate a custom answer...   | |
|  |                              [mic]   | |
|  +--------------------------------------+ |
|                                           |
|  [  Send  ]                               |
|                                           |
+------------------------------------------+
```

### 8d. Notification Banner

Slides down from the top when a P1 or P2 event occurs while the app is in
the foreground. 72px tall, swipeable.

```
+------------------------------------------+
| +--------------------------------------+ |
| |  (*) Frontend                        | |
| |  Asking: "Refactor auth module?"     | |
| |            [Approve]  [View]         | |
| +--------------------------------------+ |
|                                           |
|  (rest of current view continues below)   |
|                                           |
```

Swipe up on the banner: opens the quick action overlay.
Swipe down on the banner: dismisses it (but the session remains in WAITING state).
Tap the banner body: opens the quick action overlay.
Tap an action button: performs the action directly.

**Stacked notifications (multiple sessions need attention):**

```
+------------------------------------------+
| +--------------------------------------+ |
| |  (*) Frontend -- "Refactor auth?"    | |
| |            [Approve]  [View]         | |
| +--------------------------------------+ |
| +--------------------------------------+ |
| |  (!) Tests -- Error in npm test      | |
| |            [View Error]              | |
| +--------------------------------------+ |
| | + 1 more notification                | |
+------------------------------------------+
```

### 8e. Voice Interaction Indicator

When voice mode is active and the system is listening for a response:

```
+------------------------------------------+
|                                           |
|  (current view)                           |
|                                           |
|                                           |
|                                           |
|                                           |
|                                           |
|                                           |
|           +------------------+            |
|           |   (( mic icon )) |            |
|           |                  |            |
|           |  Listening... 4s |            |
|           |  "approve" "skip"|            |
|           +------------------+            |
|                                           |
|  [Sessions]    [Activity]     [Settings]  |
+------------------------------------------+

The mic icon pulses with the audio input level.
A circular progress ring around it shows the 5-second timeout.
Hint text shows expected voice commands.
```

---

## 9. Component Specifications

### 9a. Connection Status Indicator

```
Position: Top-right of header bar
Size: 8px circle + optional label

States:
  Green dot               -> Connected (no label)
  Yellow dot + "..."      -> Reconnecting
  Red dot + "Offline"     -> Disconnected (after 10s of failed reconnects)
```

### 9b. Session Card (Component Detail)

```
Width: 100% - 32px (16px margin each side)
Min height: 64px (compact, no actions)
Max height: 120px (expanded, with action buttons)
Border radius: 12px
Padding: 12px 16px

State dot: 12px diameter, left-aligned, vertically centered with name
Name: 16px, semibold, system font
Timestamp: 14px, regular, muted color, right-aligned with name
Summary: 14px, regular, single line with ellipsis overflow
Action buttons: 36px height, 12px padding horizontal, 8px gap

Swipe threshold: 80px horizontal for action trigger
Swipe visual: Color reveal behind card (green right = approve, gray left = dismiss)

IMPORTANT: On mobile/touch devices, Hide and Close buttons are HIDDEN.
Swipe gestures are the ONLY way to dismiss/close cards on mobile.
Buttons are only shown on desktop (hover:hover + pointer:fine).
Detection uses both (hover: none) and (pointer: coarse) media queries
to reliably catch all touch-primary devices including Android Chrome.
```

### 9c. Quick Action Overlay (Component Detail)

```
Type: Bottom sheet with drag handle
Max height: 60% of viewport (can drag to expand to 90%)
Border radius: 16px top-left, 16px top-right
Background: System background with slight blur on backdrop
Drag handle: 36px wide, 4px tall, centered, muted color

Action buttons: 48px height (minimum), full width or 50% width side-by-side
Button spacing: 8px gap
Button style: Filled for primary (Approve), Outlined for secondary (Reject)
```

### 9d. Activity Feed Item

```
Each item in the unified activity feed:

+------------------------------------------+
|  [Session dot + name]        [timestamp]  |
|  [Tool icon] Action description           |
|  [Expandable detail area]                 |
+------------------------------------------+

Tool icons (emoji, 16px):
  Read    -> book
  Write   -> pencil
  Edit    -> wrench
  Bash    -> terminal
  Grep    -> magnifying glass
  WebFetch -> globe
  Task    -> branch/fork
  Stop    -> checkmark circle
  Error   -> X circle
  User    -> speech bubble
```

---

## 10. Accessibility

- **VoiceOver / TalkBack**: All interactive elements have proper ARIA labels.
  State dots include text descriptions ("Frontend: waiting for input").
- **Color independence**: States are distinguishable by dot animation pattern
  (pulsing vs. static) in addition to color. Cards with actions have a subtle
  left border in the state color as a secondary indicator.
- **Font scaling**: Layouts are flexible. Cards grow taller with larger fonts
  rather than clipping. Tested at 200% font scale.
- **Reduced motion**: Disable pulse animations and slide transitions when the
  system prefers-reduced-motion is set. Use opacity changes instead.
- **High contrast**: State dot colors pass WCAG AA contrast against both light
  and dark backgrounds.

---

## 11. Dark Mode

Dark mode is the default. Developers staring at a phone while walking around
the house at night should not be blinded. The interface follows the system
theme preference but defaults to dark.

| Element | Light Mode | Dark Mode |
|---------|-----------|-----------|
| Background | #FFFFFF | #1C1C1E |
| Card background | #F5F5F7 | #2C2C2E |
| Card background (waiting) | #FFF8E1 | #3D3520 |
| Card background (error) | #FFEBEE | #3D2020 |
| Text primary | #1C1C1E | #FFFFFF |
| Text secondary | #6C6C70 | #98989D |
| State dot (green) | #34C759 | #30D158 |
| State dot (amber) | #FF9F0A | #FFD60A |
| State dot (red) | #FF3B30 | #FF453A |
| State dot (blue) | #007AFF | #0A84FF |
| State dot (gray) | #8E8E93 | #636366 |

---

## 12. Data Flow Integration

Remote Claude reuses the Vibecraft event system. The server component from
Vibecraft (WebSocket server on port 4003) is the data source. The mobile
client connects via WebSocket and receives the same `ServerMessage` types.

### Event to UI Mapping

| Server Message | UI Update |
|---------------|-----------|
| `event` (pre_tool_use) | Update card summary to current action |
| `event` (post_tool_use) | Update card summary with result |
| `event` (stop) | Transition to FINISHED, trigger P2 notification |
| `event` (notification, permission_prompt) | Transition to WAITING, trigger P1 notification |
| `event` (notification, idle_prompt) | Transition to WAITING, trigger P1 notification |
| `event` (notification, elicitation_dialog) | Transition to WAITING, trigger P1 notification |
| `event` (user_prompt_submit) | Transition to WORKING |
| `event` (session_start) | Add card or transition to WORKING |
| `event` (session_end) | Transition to FINISHED |
| `sessions` | Full refresh of all cards |
| `session_update` | Update single card |
| `permission_prompt` | Show quick action overlay |
| `permission_resolved` | Close quick action overlay, clear WAITING state |
| `tokens` | Update token count in session detail |

### Client to Server Actions

| User Action | Client Message |
|-------------|---------------|
| Approve/reject permission | `permission_response` with session ID and response |
| Send text response | POST to `/prompt` endpoint with session ID and text |
| Refresh sessions | `subscribe` (triggers fresh `sessions` message) |

---

## 13. Performance Budgets

| Metric | Target | Rationale |
|--------|--------|-----------|
| First Contentful Paint | < 1.5s | PWA with cached shell |
| Time to Interactive | < 2.5s | User needs to act on notifications fast |
| WebSocket connect | < 500ms | Local network only |
| Card render (per card) | < 16ms | 60fps scroll |
| Notification to screen | < 200ms | P1 events must feel instant |
| TTS latency (event to speech start) | < 2s | Natural conversation feel |
| STT latency (speech end to action) | < 1s | Responsive voice interaction |
| Bundle size (gzipped) | < 100KB | Fast load on mobile |
| Memory usage | < 50MB | Runs alongside other apps |

---

## 14. Technology Recommendations

| Component | Recommendation | Rationale |
|-----------|---------------|-----------|
| Framework | Preact or vanilla + lit-html | Minimal bundle, fast rendering |
| Styling | CSS Modules or Tailwind | Scoped styles, no runtime cost |
| State | Zustand or nanostores | Tiny, no boilerplate |
| WebSocket | Native WebSocket + reconnect wrapper | No library needed |
| TTS | Web Speech API (SpeechSynthesis) + ElevenLabs fallback | Free local TTS, premium option |
| STT | Web Speech API (SpeechRecognition) + Deepgram fallback | Browser-native, low latency |
| Push Notifications | Web Push API + service worker | Works when app is backgrounded |
| Haptics | Vibration API | Simple patterns, widely supported |
| Build | Vite | Matches Vibecraft, fast builds |

---

## Sources

The following research informed the patterns and decisions in this document:

- [20 Dashboard UI/UX Design Principles for 2025](https://medium.com/@allclonescript/20-best-dashboard-ui-ux-design-principles-you-need-in-2025-30b661f2f795)
- [UX Strategies for Real-Time Dashboards -- Smashing Magazine](https://www.smashingmagazine.com/2025/09/ux-strategies-real-time-dashboards/)
- [Dashboard Design Principles -- UXPin](https://www.uxpin.com/studio/blog/dashboard-design-principles/)
- [7 Mobile UX/UI Design Patterns Dominating 2026](https://www.sanjaydey.com/mobile-ux-ui-design-patterns-2026-data-backed/)
- [Design Guidelines for Better Notifications UX -- Smashing Magazine](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/)
- [Push Notification UX Design Guide 2025 -- UXCam](https://uxcam.com/blog/push-notification-guide/)
- [Notification Design Guide -- Toptal](https://www.toptal.com/designers/ux/notification-design)
- [Voice User Interface Design Principles 2026 -- ParallelHQ](https://www.parallelhq.com/blog/voice-user-interface-vui-design-principles)
- [Voice User Interface Design Best Practices -- Lollypop](https://lollypop.design/blog/2025/august/voice-user-interface-design-best-practices/)
- [The Voice AI Stack for Building Agents 2026 -- AssemblyAI](https://www.assemblyai.com/blog/the-voice-ai-stack-for-building-agents)
- [The Thumb Zone: Designing for Mobile Users -- Smashing Magazine](https://www.smashingmagazine.com/2016/09/the-thumb-zone-designing-for-mobile-users/)
- [How to Design Mobile Apps for One-Hand Usage -- Smashing Magazine](https://www.smashingmagazine.com/2020/02/design-mobile-apps-one-hand-usage/)
- [Progressive Disclosure -- NNGroup](https://www.nngroup.com/articles/progressive-disclosure/)
- [Progressive Disclosure for Mobile Apps -- UX Planet](https://uxplanet.org/design-patterns-progressive-disclosure-for-mobile-apps-f41001a293ba)
- [iOS Live Activities -- Pushwoosh](https://www.pushwoosh.com/blog/ios-live-activities/)
- [Live Activities -- Apple Developer Documentation](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)
- [Designing Swipe-to-Delete Interactions -- LogRocket](https://blog.logrocket.com/ux-design/accessible-swipe-contextual-action-triggers/)
- [Material Design Gestures](https://m2.material.io/design/interaction/gestures.html)
- [Status Indicators -- Carbon Design System](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/)
- [Visibility of System Status in UI -- UX Planet](https://uxplanet.org/4-ways-to-communicate-the-visibility-of-system-status-in-ui-14ff2351c8e8)
