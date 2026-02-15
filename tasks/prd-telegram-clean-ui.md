# PRD: Telegram Clean UI

## Introduction

The Telegram integration has two compounding problems: **too much noise** (every tool call is a separate message) and **missing useful content** (diffs, plans, reasoning, long responses get lost or truncated). A typical 10-minute Claude session produces 30+ messages in Telegram, yet the user can't see what files actually changed, can't read the full plan Claude proposed, and gets truncated summaries. This redesign fixes content delivery first, then cleans up presentation — evolving the existing `TelegramBot.onEvent`/`flushEventBuffer` pipeline rather than rewriting from scratch.

## Root Causes (from investigation)

1. **Edit diffs never sent** — `old_string`/`new_string` captured in hook events, rendered in web dashboard, but Telegram only shows "✏️ Editing file.ts"
2. **Responses truncated to 3.5KB** — hook captures 16KB of `assistantText`, but `TelegramBot.onStatusChange` slices to 3500 chars before sending the "finished" notification
3. **Plans lost after approval** — ExitPlanMode shows plan content during permission prompt, but the subsequent "finished" notification doesn't re-include it
4. **Reasoning buried** — `assistantText` on tool events contains Claude's thinking but is only shown as a max-300-char italic snippet, if at all
5. **Per-tool-call messages** — every Read, Grep, Glob, Bash gets its own line, creating a wall of noise that buries the useful content above

## Goals

- Surface edit diffs in Telegram (at least filenames + summary of changes)
- Deliver full responses without premature truncation (use Telegram's 4096 char limit, split into multiple messages when needed)
- Show plans prominently in both approval AND finished notifications
- Replace per-tool-call event stream with periodic activity digests
- Push notifications only for questions/approvals and finished status

## User Stories

### US-001: Show edit diffs in Telegram
**Description:** As a user monitoring remotely, I want to see what code Claude actually changed, not just "Editing file.ts", so I can review changes without switching to the web dashboard.

**Acceptance Criteria:**
- [ ] When an Edit event is in the flush buffer, include a short diff summary in the digest: filename + lines changed
- [ ] For permission prompts on Edit tools, show first ~15 lines of old→new in a code block (like the web dashboard does)
- [ ] Write tool: show filename + first few lines of content being written
- [ ] Diff content uses `<pre>` formatting in Telegram
- [ ] Total diff content budget: ~1500 chars per edit (fits within message limits alongside other content)
- [ ] Typecheck passes

### US-002: Fix response truncation
**Description:** As a user, I want to read Claude's full response in the "finished" notification, not a 3.5KB slice of a 16KB response.

**Acceptance Criteria:**
- [ ] Remove the hardcoded 3500-char truncation in `TelegramBot.onStatusChange`
- [ ] Use `splitMessage()` (already exists) to split long responses across multiple Telegram messages (4000 char budget each)
- [ ] Set a reasonable upper limit (e.g., 8000 chars / 2 messages max) to avoid flooding for extremely long responses
- [ ] Truncation message `[... full response truncated, N chars total]` shown when limit is hit
- [ ] Expandable blockquote used for content over 300 chars (current behavior preserved)
- [ ] Typecheck passes

### US-003: Preserve plan content through to finished notification
**Description:** As a user, I want to see the plan Claude executed in the "finished" message, so I have a record of what was planned and completed.

**Acceptance Criteria:**
- [ ] When a session's last tool call was ExitPlanMode, store `planContent` on the session object (alongside `lastAssistantText`)
- [ ] The "finished" notification includes the plan content (or a summary) if available
- [ ] Plan shown with `📋 Plan:` header, formatted with `markdownToTelegramHtml()`
- [ ] If both plan and response text exist, plan shown first, then response summary
- [ ] Plan content cleared when session starts new work (next `working` status)
- [ ] Typecheck passes

### US-004: Replace per-tool event stream with activity digests
**Description:** As a user, I want tool activity collapsed into periodic one-line digests instead of a message per tool call, so I can scan the topic without drowning in noise.

**Acceptance Criteria:**
- [ ] Tool calls (Read, Grep, Glob, Edit, Write, Bash, Task, etc.) buffered and collapsed into a single digest line per flush cycle
- [ ] Digest format: `⚙️ verb1 · verb2 · verb3` — human-readable verbs, not raw tool names
- [ ] Deduplication: repeated tools collapsed (e.g., 5 Reads → "read 5 files", multiple Greps → "searched N patterns")
- [ ] Edited files always named: "edited foo.ts" not just "edited file"
- [ ] Bash: uses `description` when available, otherwise truncated command (max 40 chars)
- [ ] Maximum one digest message per flush cycle (10s interval, may tune later)
- [ ] Digest messages sent with `disable_notification: true` (silent — no push)
- [ ] Typecheck passes

### US-005: Surface Claude's reasoning in digests
**Description:** As a user, I want to see Claude's key thinking alongside activity, so I understand *why* it's doing things, not just tool names.

**Acceptance Criteria:**
- [ ] When `assistantText` is present in tool events during a flush cycle, the most substantive snippet included below the digest line
- [ ] Reasoning shown as indented italic text (`<i>` tag), max 300 chars
- [ ] "Most substantive" = longest non-trivial `assistantText` in the burst (skip filler like "Let me check..." or single-sentence transitions)
- [ ] If no meaningful reasoning text exists, omit — don't show empty/filler
- [ ] Reasoning text cleaned of RC markers before display
- [ ] Typecheck passes

### US-006: Build `formatActivityDigest()` helper
**Description:** As a developer, I need a testable formatting function that converts a buffer of tool events into a clean digest line.

**Acceptance Criteria:**
- [ ] New function `formatActivityDigest(events)` in `telegram-format.ts`
- [ ] Input: array of buffered tool events (tool name, toolInput, assistantText)
- [ ] Output: formatted string with `⚙️ verb · verb · verb` and optional reasoning line
- [ ] Handles dedup: multiple Reads → "read N files", multiple Greps → "N searches"
- [ ] Handles mixed tools: "edited foo.ts · ran tests · read 3 files"
- [ ] Returns empty string if no meaningful events
- [ ] Typecheck passes

### US-007: Clean up finished notification format
**Description:** As a user, I want the "finished" notification to be concise — header + key info — not a wall of text in a blockquote.

**Acceptance Criteria:**
- [ ] Short summaries (<150 chars): inline `✅ name finished — summary here`
- [ ] Medium summaries (150-500 chars): header + indented summary line below
- [ ] Long summaries (500+ chars): header + expandable blockquote (current behavior)
- [ ] RC marker message used as summary when available (it's designed for this)
- [ ] Push notification triggered for all finished notifications (current behavior preserved)
- [ ] Typecheck passes

## Functional Requirements

- FR-1: Edit tool events must include diff content (old_string/new_string summary) in Telegram output
- FR-2: Response text in "finished" notifications must use `splitMessage()` instead of hardcoded 3500-char truncation
- FR-3: `planContent` must persist on session object from ExitPlanMode through to the stop/idle transition
- FR-4: `TelegramBot.onEvent()` must buffer tool events and flush as single digest message per session per cycle
- FR-5: `flushEventBuffer()` must call `formatActivityDigest()` instead of joining individual `formatEventLine()` outputs
- FR-6: Stop events (Claude responses) with non-silent markers must still generate standalone messages (not collapsed into digest)
- FR-7: ExitPlanMode events must generate immediate standalone plan message (bypass digest buffer)
- FR-8: Digest messages must be sent with `disable_notification: true`; push only for finished/question/error
- FR-9: `user_prompt_submit` events still tracked for `initialPrompt` but excluded from digest (already visible as user's Telegram message)

## Non-Goals

- No changes to `hooks/hook.sh` — event data pipeline stays the same
- No changes to EventProcessor — only TelegramBot and formatting
- No changes to the web dashboard
- No changes to topic lifecycle (create/close/reopen/transfer)
- No changes to inline button behavior (approve/reject)
- No changes to file upload or slash command handling
- No verbose/quiet mode toggle — this is a clean replacement of the event stream format

## Technical Considerations

- **Files to modify:** `server/TelegramBot.ts` (event buffering, flush logic, status notifications), `server/telegram-format.ts` (new `formatActivityDigest`, update finished/waiting formats), `server/SessionManager.ts` (persist `planContent` on session)
- **Existing buffer:** `eventBuffers` Map already groups events per session with 10s flush — adapt, don't rebuild
- **`formatEventLine()` reuse:** keep as internal helper for verb generation, stop sending its output directly
- **`splitMessage()` reuse:** already handles 4000-char Telegram limit — use for long responses instead of pre-truncating
- **Rate limiting:** fewer messages = less API pressure — this is a win
- **Backward compatibility:** shared types may need `planContent?: string` on Session interface

## Success Metrics

- Edit diffs visible in Telegram for every file change
- Full responses delivered (up to 8KB / 2 messages) instead of truncated at 3.5KB
- Plans visible in both approval prompt AND finished notification
- Typical 10-minute session: 3-8 topic messages instead of 20-50+
- Phone buzzes only for finished + questions, not activity digests

## Open Questions

- Should the flush interval increase from 10s to 15-20s for denser digests? (Tune after testing)
- Should extremely long diffs (e.g., full file rewrites) link to web dashboard instead? (Follow-up)
- For responses over 8KB, should we show a "View full response in dashboard" link? (Follow-up)
