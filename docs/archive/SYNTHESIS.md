# Remote Claude: Design Synthesis & MVP Roadmap

**Cross-cutting synthesis of all four design perspectives.**

---

## The Big Picture

Four parallel explorations converged on a remarkably consistent set of conclusions. Here are the key takeaways and where the perspectives diverge.

---

## 1. Points of Strong Agreement

### Use hooks, not terminal scraping
All perspectives agree: Claude Code's hooks API is the right foundation. Vibecraft proves it works. The devil's advocate found that `PermissionRequest` hooks eliminate the need for Vibecraft's fragile tmux-based permission detection entirely. **Don't parse terminal output.**

### Dual-write pattern (JSONL + HTTP POST)
Both the architecture doc and codebase analysis converge on Vibecraft's proven dual-write: append events to JSONL for persistence/recovery, POST to server for real-time latency. This is battle-tested.

### Web Speech API for MVP TTS
The tech architect recommends it for zero-config simplicity. The devil's advocate endorses it as free and sufficient. The UX designer plans around it. ElevenLabs is a Phase 2 upgrade.

### Node.js + TypeScript + Preact + Vite
Unanimous. Matches Vibecraft's proven stack. Preact's 3KB bundle vs React's 40KB matters on mobile. Vite provides the same DX as Vibecraft.

### Touch-first, voice-second for MVP
The UX designer designed both, but the devil's advocate argues (persuasively) that voice in shared spaces is awkward, and touch-based approve/reject is faster for the most common interactions. Voice mode should be optional, not default.

---

## 2. Key Tensions & Resolutions

### TTS Markers in CLAUDE.md vs. Hook-based Summarization

| Perspective | Position |
|---|---|
| **Architect** | Use `<!--rc:category:message-->` markers in CLAUDE.md |
| **Devil's Advocate** | Markers are fragile (5-20% omission rate). Eliminate them. Use Stop hook + transcript parsing + separate summarization |
| **Codebase Analysis** | Claude-to-Speech proves markers work ~80-95% of the time, with defensive defaults |

**Resolution: Both.** MVP implements the marker protocol (it's simple and provides rich categorization when it works), BUT the Stop hook also reads the transcript as a fallback. If no marker is found, the system extracts the last 200 chars of the response as a plain notification. This gives us the best of both worlds: rich categorized notifications when Claude cooperates, reasonable fallback when it doesn't.

### Permission Handling: PermissionRequest Hook vs. tmux capture-pane

| Perspective | Position |
|---|---|
| **Architect** | Use tmux capture-pane polling (Vibecraft's current approach) |
| **Devil's Advocate** | Use `PermissionRequest` hook (newer, structured, no regex) |

**Resolution: PermissionRequest hook.** The devil's advocate is right -- the hook exists now and provides structured data. Fall back to tmux polling only if the hook proves insufficient for edge cases (which we'll discover during prototyping).

### Scope: Dashboard vs. Full Control

| Perspective | Position |
|---|---|
| **UX Designer** | Rich interaction: swipe-to-approve, voice commands, session detail with diffs |
| **Devil's Advocate** | "The moment you add a prompt editor... you are building a web IDE." |

**Resolution: Progressive MVPs.** MVP 1 is pure monitoring + simple approve/reject. MVP 2 adds text prompt input. MVP 3 adds voice. Never add a code editor, file viewer, or terminal emulator.

---

## 3. The Elephant in the Room

The devil's advocate identified a potentially fatal strategic risk: **Anthropic has already shipped `claude --remote` and mobile Claude Code.**

**Our differentiators:**
1. **Local machine access** -- Anthropic's remote runs on cloud VMs, not your machine
2. **No subscription upgrade** -- Works with any Claude Code plan
3. **Customizable TTS/notifications** -- Anthropic's mobile app doesn't speak to you
4. **Open/hackable** -- Custom hooks, any LLM for summarization, etc.

**The de-risking plan:** Before writing production code, run the Day 0 experiment (see below). If Vibecraft-on-phone provides enough value, proceed. If you walk to the computer anyway, reconsider.

---

## 4. Recommended MVP Prototyping Sequence

### Day 0: Validate the Value Proposition (No Code)

Install Vibecraft. Open it on phone. Run 3 Claude Code sessions. Do chores for 1 hour.

**Questions to answer:**
- Did you check the phone, or walk to the computer?
- What information did you need most? (Status? Permission prompts? Results?)
- What actions did you need to take? (Approve? Text input? Nothing?)
- Was it useful enough to invest a week building a dedicated tool?

### Prototype 1 (Days 1-2): Hooks-Only Event Stream

**Goal:** Validate hook reliability and mobile WebSocket connectivity.

- Hook script for 7 event types -> JSONL + HTTP POST
- Minimal Node.js server: accept events, WebSocket broadcast
- Bare HTML page: event list, auto-scrolling, session status dots
- No TTS, no session management, no tmux interaction

**Success criteria:** Events appear on phone <500ms after they occur. All hook types fire reliably. Phone stays connected over WiFi while walking around.

### Prototype 2 (Days 3-4): Remote Permission Approval

**Goal:** Validate the core interaction loop.

- PermissionRequest hook relays to phone via WebSocket
- Phone shows "Approve / Deny" buttons
- User response sent back, hook returns decision
- Measure: time from Claude's request to user's approval

**Success criteria:** Permission approved from phone in <10 seconds. Claude resumes immediately.

### Prototype 3 (Days 5-6): TTS + Text Input

**Goal:** Validate voice output and remote prompt input.

- On Stop event, extract response text, send to browser Web Speech API
- Add text input on phone for sending prompts to sessions
- Test TTS with actual chores

**Success criteria:** TTS is useful (not annoying). Text input works for simple responses.

### MVP (Day 7): Polish & Ship

- Session cards with status indicators
- Responsive mobile CSS
- Auth token + QR code setup
- `npx remote-claude setup` script

---

## 5. Architecture Decision Records

### ADR-1: Hooks over Terminal Scraping
**Decision:** Use Claude Code hooks as primary data source.
**Rationale:** Structured JSON, documented API, version-stable. Terminal scraping is fragile and proven painful in Vibecraft's permission detection code.
**Consequences:** Depends on Claude Code's hook system continuing to exist and expand.

### ADR-2: Web Speech API over ElevenLabs for MVP
**Decision:** Use browser-native TTS for MVP.
**Rationale:** Free, zero-config, works offline, good enough quality for status announcements. ElevenLabs adds cost, latency, and API key management.
**Consequences:** Voice quality is robotic. Acceptable for status updates, not for long narration.

### ADR-3: Preact over React
**Decision:** Use Preact (3KB) instead of React (40KB).
**Rationale:** Mobile bundle size matters. Same API. Vite + @preact/preset-vite provides identical DX.
**Consequences:** Some React ecosystem libraries may not work. Acceptable for a dashboard app.

### ADR-4: No Database
**Decision:** Use JSONL + JSON files for all persistence.
**Rationale:** Local dev tool with one user. SQLite/Postgres/Redis add complexity with no benefit. Vibecraft proves this scales fine for the use case.
**Consequences:** No query capability. Acceptable -- we only need append, read-last-N, and key-value.

### ADR-5: LAN-Only by Default
**Decision:** Server listens on LAN, no internet exposure.
**Rationale:** Simplest security model. Tailscale recommended for remote access.
**Consequences:** User must be on same network (or use VPN). Acceptable for primary use case (phone in same house).

### ADR-6: Marker Protocol with Fallback
**Decision:** Implement TTS markers (`<!--rc:category:message-->`) AND transcript-based fallback.
**Rationale:** Markers provide rich categorization when Claude cooperates. Transcript fallback ensures something always works. Belt and suspenders.
**Consequences:** Two code paths for TTS content extraction. Small additional complexity.

---

## 6. File Deliverables

| File | Contents | Lines |
|------|----------|-------|
| `DESIGN.md` | Mobile UX design: wireframes, interaction patterns, state machine, notifications, voice flows | ~1070 |
| `docs/ARCHITECTURE.md` | Technical architecture: system diagram, tmux integration, WebSocket protocol, server API, frontend structure | ~400 |
| `docs/RISKS.md` | Risk analysis: 15+ identified risks with ratings and mitigations, de-risking prototypes, scope warnings | ~350 |
| `docs/CODEBASE-ANALYSIS.md` | Reference project analysis: Claude-to-Speech and Vibecraft patterns, reusable code, tech stack synthesis | ~200 |
| `docs/SYNTHESIS.md` | This document: cross-cutting synthesis, tensions resolved, MVP roadmap, ADRs | ~200 |

---

## 7. What NOT to Build

Explicitly out of scope, per devil's advocate:

- Code editor or file viewer on phone
- Terminal emulator on phone
- Conversation history browser
- Multi-user support
- 3D visualization (Vibecraft does this)
- Custom themes or animations
- Database or event processing pipeline
- OAuth or complex auth
- Native mobile app (PWA is sufficient for MVP)

**The phone is for monitoring status and approving requests. The computer is for actual work.**
