// Frontend types for Remote Claude
// Mirrors shared/types.ts but kept local to avoid build complexity

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
  claudeSessionId?: string;
  lastMarker?: RcMarker;
  lastAssistantText?: string;
  permissionRequest?: { tool: string; toolInput: Record<string, unknown> };
  windowName?: string;
  gitBranch?: string;
  gitDirty?: boolean;
  totalTokens?: number;
}

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
  | { type: 'ping' }
  | { type: 'select_session'; payload: { sessionId: string } };

export interface PendingImage {
  name: string;
  dataUrl: string;
  base64: string;
  mimeType: string;
}
