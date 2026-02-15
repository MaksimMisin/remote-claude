// ============================================================
// Shared types for Remote Claude
// Used by: server, hook (as reference), frontend (inline)
// ============================================================

// --- Session Types ---
//
// "Session" = a Claude Code instance, NOT a tmux session.
// Server-created sessions run as windows in the shared 'remote-claude' tmux session.
// Auto-discovered sessions run in whatever tmux session/window/pane the user launched them in.
// The tmuxTarget field (e.g. "Personal:3.0") encodes the full tmux address: session:window.pane.

export type SessionStatus = 'idle' | 'working' | 'waiting' | 'offline';

export interface ManagedSession {
  id: string;
  name: string;
  tmuxSession: string;
  tmuxTarget?: string;
  status: SessionStatus;
  createdAt: number;
  lastActivity: number;
  cwd: string;
  currentTool?: string;
  currentToolInput?: Record<string, unknown>;
  claudeSessionId?: string;
  lastMarker?: RcMarker;
  lastAssistantText?: string;
  permissionRequest?: { tool: string; toolInput: Record<string, unknown> };
  windowName?: string;
  customName?: string;
  flags?: string;
  gitBranch?: string;
  gitDirty?: boolean;
  totalTokens?: number;
  /** Plan content from ExitPlanMode — persisted so the finished notification can include it. */
  planContent?: string;
  /** Set by session_end timer — Claude exited but the shell pane is still alive.
   *  Prevents health check from reviving the session to idle. Cleared on session_start. */
  claudeExited?: boolean;
}

// --- Event Types ---

export type HookEventType =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'user_prompt_submit'
  | 'session_start'
  | 'session_end'
  | 'notification';

export interface ClaudeEvent {
  id: string;
  timestamp: number;
  type: HookEventType;
  sessionId: string;
  cwd: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  success?: boolean;
  error?: string;
  assistantText?: string;
  marker?: RcMarker;
  tmuxTarget?: string;
  gitBranch?: string;
  gitDirty?: boolean;
  totalTokens?: number;
}

// --- TTS Marker Types ---

export type MarkerCategory =
  | 'notification'
  | 'summary'
  | 'question'
  | 'progress'
  | 'error'
  | 'finished'
  | 'silent';

export interface RcMarker {
  category: MarkerCategory;
  message: string;
}

// --- WebSocket Protocol ---

export type ServerMessage =
  | { type: 'connected'; payload: { version: string } }
  | { type: 'sessions'; payload: ManagedSession[] }
  | { type: 'session_update'; payload: ManagedSession }
  | { type: 'event'; payload: ClaudeEvent }
  | { type: 'history'; payload: ClaudeEvent[] }
  | { type: 'marker'; payload: { sessionId: string; marker: RcMarker } }
  | { type: 'session_removed'; payload: { sessionId: string } };

export type ClientMessage =
  | { type: 'subscribe' }
  | { type: 'ping' };
