# Event Pipeline -- Architecture & Pitfalls

How events flow from Claude Code to the dashboard, and lessons learned.

---

## Event Flow

```
Claude Code (in tmux pane)
    |
    | Hook fires (stdin JSON)
    v
Hook Script (remote-claude-hook.sh)
    |
    +---> 1. Append to events.jsonl (synchronous)
    |
    +---> 2. POST to server /event (backgrounded curl, fire-and-forget)
    |
    v
Server (EventProcessor)
    |
    | Events arrive via TWO paths:
    |   A. HTTP POST /event  (from hook's curl)
    |   B. File watcher      (chokidar watches events.jsonl)
    |
    | Both paths call ingest() which deduplicates by event ID
    |
    v
WebSocket broadcast to all connected dashboard clients
    |
    v
Frontend (React)
    |
    | addEvent() deduplicates by event ID before adding to state
    v
EventFeed component renders events
```

### Why Dual Delivery?

- **HTTP POST** provides low-latency delivery (~50ms)
- **File watcher** provides crash recovery -- if the server is down when hook fires, events are persisted in JSONL and picked up when the server restarts
- Deduplication via event IDs ensures events aren't processed twice

### Event ID Format

`{claudeSessionId}-{timestampMs}-{randomHex}`

Example: `a1b2c3d4-1707400000000-f3a1`

The ID is generated in the hook script, so both delivery paths carry the same ID.

---

## Deduplication

### Server-side (EventProcessor)

- `seenIds: Set<string>` -- tracks all ingested event IDs
- `ingest(event)` returns `false` if ID already seen
- `seenIds` is periodically trimmed to prevent unbounded growth

### Client-side (React state)

```typescript
setEvents((prev) => {
  const list = prev[key] || [];
  if (list.some((e) => e.id === ev.id)) return prev;  // dedup
  ...
});
```

Both layers must be present:
- Server-side dedup prevents double-broadcast via WebSocket
- Client-side dedup handles reconnection overlap (history + real-time events)

---

## Event Types and What They Mean

| Hook Event | Internal Type | When It Fires |
|-----------|---------------|---------------|
| SessionStart | `session_start` | Claude Code session begins |
| UserPromptSubmit | `user_prompt_submit` | User submits a prompt (typed or pasted) |
| PreToolUse | `pre_tool_use` | Claude is about to use a tool |
| PostToolUse | `post_tool_use` | Tool execution completed |
| Notification | `notification` | Permission prompt, idle prompt, or other notification |
| Stop | `stop` | Claude finished responding (includes assistant text + markers) |
| SessionEnd | `session_end` | Claude Code session terminates |

### pre_tool_use vs notification

These often fire in quick succession for the same tool call:

1. `pre_tool_use` -- Claude announces it will use a tool (contains tool name + input)
2. `notification` -- Claude Code asks for permission (if the tool requires approval)

Both events reference the same tool and toolInput. In the dashboard event feed, this looks like two entries 1 second apart with the same description. **This is expected behavior**, not a bug. The `pre_tool_use` shows what Claude intends to do; the `notification` shows it needs approval.

The event feed handles this by:
- Showing `pre_tool_use` only when it has `assistantText` (Claude's reasoning) or expandable tool details (Edit diffs, Bash commands, etc.)
- Always showing `notification` events (they indicate the session is waiting)

---

## Pitfall: Synthetic Event Duplication (Fixed)

### The Problem

When a user sent a prompt from the dashboard, **two** `user_prompt_submit` events appeared in the feed.

### Root Cause

The server's `POST /api/sessions/:id/prompt` handler did two things:

1. Sent the prompt text to the tmux pane (via load-buffer/paste-buffer)
2. Created a **synthetic** `user_prompt_submit` event with ID `web-{timestamp}-{hex}` and ingested it

Then Claude Code received the prompt and fired its `UserPromptSubmit` hook, which created a **second** event with ID `{sessionId}-{timestamp}-{hex}`.

Since both events had different IDs, neither server-side nor client-side dedup caught the duplicate. Result: two identical-looking prompt entries in the event feed.

### The Fix

Removed the synthetic event creation from the server's prompt handler. The hook-generated event is the single source of truth. The ~100ms delay before the event appears (hook fires -> curl POST -> server ingest -> WebSocket broadcast) is imperceptible.

### Lesson

Never create synthetic events that duplicate what hooks will naturally produce. The hook system is the canonical event source. If you need instant feedback in the UI, handle it client-side (e.g., optimistic UI) rather than injecting server-side synthetic events that can't be deduplicated against hook events.

---

## Pitfall: Slash Command Events

Slash commands (e.g., `/help`, `/compact`) don't trigger the normal hook event flow -- Claude Code handles them internally without firing `UserPromptSubmit` or `Stop` hooks. To capture their output, the server uses tmux pane diffing:

1. Capture pane content before sending the command
2. Wait 2 seconds for the command to execute
3. Capture pane content after
4. Diff to extract new output
5. Create a synthetic `stop` event with the diff as `assistantText`

This is the one case where synthetic events are correct -- there's no hook event to duplicate.

---

## Session ID Mapping

Claude Code uses full UUIDs for session IDs (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`).
The server uses short IDs (first 8 chars: `a1b2c3d4`) for session keying.

Events arrive with full `sessionId`. The `EventProcessor` and frontend both use `sessionId.slice(0, 8)` to key event buckets. The `ManagedSession` stores both:
- `id` -- short ID (8 chars), used as the session key
- `claudeSessionId` -- full UUID, used for event matching

When the frontend selects a session, it looks up `session.claudeSessionId.slice(0, 8)` to find the matching event bucket.

---

## File Format: events.jsonl

One JSON object per line. Fields match the `ClaudeEvent` type in `shared/types.ts`.

The file grows unboundedly. The server only loads the last ~500 lines on startup for history seeding. Consider periodic rotation for long-running setups.
