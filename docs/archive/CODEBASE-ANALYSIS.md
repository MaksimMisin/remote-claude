# Related Codebase Analysis: Claude-to-Speech & Vibecraft

**Purpose:** Extract reusable patterns and architecture decisions from reference projects.

---

## Project 1: Claude-to-Speech

### Overview
Voice-first interaction mode for Claude Code with automatic TTS via ElevenLabs API.

**Tech Stack:** Python 3.7+, ElevenLabs API, Quart server, pygame.mixer

### Architecture

```
Claude Code -> Stop Hook (bash) -> Extract TTS markers -> claude_speak.py -> ElevenLabs API -> Audio
```

**Key Files:**
- `hooks/stop.sh` -- Bash hook that extracts TTS markers from responses
- `scripts/claude_speak.py` -- Python TTS interface
- `server/tts_server.py` -- Optional centralized Quart server (port 5001)
- `commands/*.md` -- Slash command definitions
- `.claude-plugin/plugin.json` -- Plugin metadata

### TTS Marker Protocol
- Format: `<!-- TTS: "text to speak" -->`
- Three patterns: active speech, explicit silence (`<!-- TTS: SILENT -->`), no marker (defaults to silent)
- Hook uses regex extraction, handles both escaped and unescaped HTML variants
- 2-second deduplication window with MD5 hash tracking in `/tmp/claude_tts_dedup_cache.json`

### Dual Mode Support
1. **Direct API Mode (default):** Calls ElevenLabs directly, no server needed
2. **Local TTS Server Mode:** Persistent Quart server on LAN, audio caching, multi-device support

### Key Patterns to Reuse
- **Deduplication cache** with time-windowed hash tracking
- **Defensive bash hook** with cross-platform PATH setup and error handling
- **Voice mapping system** (name -> ElevenLabs voice ID)
- **Flock-based atomic file locking** for concurrent hook fires

---

## Project 2: Vibecraft

### Overview
Real-time 3D visualization of Claude Code activity as an interactive workshop with multi-session orchestration.

**Tech Stack:** TypeScript, Three.js, Tone.js, Node.js + WebSocket, Vite

### Architecture

```
Claude Code -> Hook (bash/jq) -> JSONL log + HTTP POST -> WebSocket Server -> Browser (Three.js)
```

**Key Files:**
- `hooks/vibecraft-hook.sh` -- Comprehensive bash hook (8 event types)
- `server/index.ts` -- WebSocket + HTTP server (port 4003)
- `shared/types.ts` -- All TypeScript types
- `shared/defaults.ts` -- Default configuration values
- `src/events/EventBus.ts` -- Central event dispatcher
- `src/events/handlers/*.ts` -- Modular event handlers

### Event Capture (8 Hook Points)
- PreToolUse, PostToolUse, Stop, SubagentStop
- SessionStart, SessionEnd, UserPromptSubmit, Notification

Each event is normalized to:
```json
{
  "id": "session-timestamp-random",
  "timestamp": 1234567890000,
  "type": "pre_tool_use",
  "sessionId": "session-123",
  "cwd": "/current/directory",
  "tool": "Read",
  "toolInput": {},
  "toolUseId": "tool-123"
}
```

### Data Flow
1. Hook reads from stdin (Claude Code pipe)
2. Transforms to event format using jq
3. **Dual write:** Appends to `~/.vibecraft/data/events.jsonl` + POSTs to server
4. Server broadcasts to WebSocket clients
5. Browser renders visualization

### Session Management
```typescript
ManagedSession {
  id: string              // UUID
  name: string            // User-friendly name
  tmuxSession: string     // tmux session name
  status: 'idle' | 'working' | 'offline'
  createdAt: number
  lastActivity: number
  cwd: string
}
```

- Each managed session gets unique tmux session: `vibecraft-{uuid}`
- Prompts sent via `tmux load-buffer` + `paste-buffer` (safe text injection)
- Health checks every 5 seconds
- Working timeout: auto-transitions to idle after 2 min inactivity

### Server Endpoints

```
GET  /health, /status, /sessions
POST /sessions, /sessions/:id/prompt, /sessions/:id/cancel
POST /event (hook notification)
PATCH /sessions/:id
DELETE /sessions/:id
```

### EventBus Pattern
Decoupled handler modules registered via `eventBus.on()`:
- `soundHandlers.ts` -- Tool sounds, lifecycle sounds
- `notificationHandlers.ts` -- Floating text above zones
- `characterHandlers.ts` -- Movement, states, animations
- `subagentHandlers.ts` -- Task spawn/remove
- `zoneHandlers.ts` -- Zone attention/status
- `feedHandlers.ts` -- Activity feed

### Key Patterns to Reuse

1. **Dual write (JSONL + HTTP POST)** -- Persistence + real-time
2. **Chokidar file watching** -- JSONL change detection for crash recovery
3. **EventBus pattern** -- Decoupled handler registration
4. **Session model** -- Extend for mobile device tracking
5. **`load-buffer`/`paste-buffer` for tmux** -- Safe text injection
6. **Origin validation** -- CSRF prevention
7. **Input sanitization** -- Path/session name validation
8. **Working timeout** -- Failsafe for stuck sessions
9. **Event ID deduplication** -- Prevents replay on reconnect

### Security Patterns
- Origin header validation (localhost + vibecraft.sh only)
- Directory path validation (no shell metacharacters)
- tmux session name validation (alphanumeric + underscore/hyphen)
- Body size limits (1MB max)
- `execFile` (not `exec`) for all shell commands

---

## Synthesis: Reusable Blueprint for Remote Claude

### Recommended Tech Stack

| Layer | Technology | Source |
|-------|-----------|--------|
| Backend | Node.js + TypeScript | Vibecraft (proven) |
| Real-time | WebSocket (ws) | Vibecraft |
| Persistence | JSONL + JSON files | Both projects |
| Hook system | Bash + jq | Both projects |
| Frontend | Preact or vanilla + Vite | Vibecraft pattern |
| TTS (mobile) | Web Speech API | New (free, zero-config) |
| TTS (desktop) | ElevenLabs API | Claude-to-Speech |

### Configuration Cascade

```
1. Code defaults (shared/defaults.ts)
2. Environment variables (.env)
3. Config file (~/.remote-claude/config.json)
4. Runtime options (CLI flags)
```

### Data Directory Structure

```
~/.remote-claude/
  data/
    events.jsonl          # Append-only event log
    sessions.json         # Session state persistence
    auth-token.txt        # Auth token (mode 0600)
    config.json           # User settings
  hooks/
    remote-claude-hook.sh # Installed hook script
```

### Error Handling & Resilience

From Claude-to-Speech:
- Retry logic with exponential backoff
- Timeout handling
- Fallback behaviors (silent on TTS failure)

From Vibecraft:
- Connection loss recovery (auto-reconnect)
- Stale session detection (health checks)
- Graceful degradation
- Event ID deduplication

### Coexistence

Both reference projects can coexist with Remote Claude. All three use:
- Different data directories
- Different server ports
- Independent hook scripts (Claude Code supports multiple hooks per event)
