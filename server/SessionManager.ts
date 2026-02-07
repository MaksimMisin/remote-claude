// ============================================================
// SessionManager -- Session CRUD, lifecycle, health checks
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  SESSIONS_FILE,
  HEALTH_CHECK_INTERVAL_MS,
  WORKING_TIMEOUT_MS,
} from '../shared/defaults.js';
import type { ManagedSession, ClaudeEvent, SessionStatus } from '../shared/types.js';
import * as tmux from './TmuxController.js';

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private onSessionUpdate: (session: ManagedSession) => void;
  private onSessionRemoved: (sessionId: string) => void;

  constructor(
    onSessionUpdate: (session: ManagedSession) => void,
    onSessionRemoved?: (sessionId: string) => void,
  ) {
    this.onSessionUpdate = onSessionUpdate;
    this.onSessionRemoved = onSessionRemoved || (() => {});
    this.load();
  }

  /** Build a human-readable context string for notification events (tool permission prompts). */
  private static buildNotificationContext(tool: string, toolInput: Record<string, unknown>): string {
    if (tool === 'AskUserQuestion') {
      // Extract question text from AskUserQuestion tool input
      const questions = toolInput.questions as Array<{ question?: string }> | undefined;
      if (questions && questions.length > 0) {
        return questions.map(q => q.question || '').filter(Boolean).join('\n');
      }
      return 'Asking a question';
    }
    if (tool === 'Bash') {
      const cmd = (toolInput.command as string) || '';
      const desc = (toolInput.description as string) || '';
      return desc ? `Run command: ${desc}\n$ ${cmd.slice(0, 300)}` : `Run command:\n$ ${cmd.slice(0, 400)}`;
    }
    if (tool === 'Edit' || tool === 'Write') {
      const fp = (toolInput.file_path as string) || '';
      const fname = fp.split('/').pop() || fp;
      return `${tool}: ${fname}`;
    }
    if (tool === 'Read') {
      const fp = (toolInput.file_path as string) || '';
      const fname = fp.split('/').pop() || fp;
      return `Read: ${fname}`;
    }
    // Generic: just show the tool name
    return `Wants to use: ${tool}`;
  }

  /** Load sessions from disk, mark all as offline until health check confirms. */
  private load(): void {
    try {
      if (existsSync(SESSIONS_FILE)) {
        const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as ManagedSession[];
        for (const s of data) {
          s.status = 'offline';
          this.sessions.set(s.id, s);
        }
      }
    } catch {
      // Start fresh
    }
  }

  /** Persist sessions to disk. */
  private save(): void {
    try {
      const dir = dirname(SESSIONS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(SESSIONS_FILE, JSON.stringify(this.list(), null, 2));
    } catch (err) {
      console.error('[SessionManager] Failed to save:', err);
    }
  }

  list(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /** Find a session matching the given event by claudeSessionId or cwd. */
  findByEvent(event: ClaudeEvent): ManagedSession | undefined {
    // First try exact Claude session ID match
    for (const s of this.sessions.values()) {
      if (s.claudeSessionId && s.claudeSessionId === event.sessionId) return s;
    }
    // CWD match ONLY for server-created sessions awaiting their first event
    // (have tmuxSession but no claudeSessionId yet). Without this guard, a
    // second Claude launched in the same project directory would have its
    // events stolen by the first session instead of being auto-discovered.
    for (const s of this.sessions.values()) {
      if (s.tmuxSession && !s.claudeSessionId && s.cwd === event.cwd && s.status !== 'offline') return s;
    }
    return undefined;
  }

  /** Create a new session as a window in the shared tmux session. */
  async create(name: string, cwd: string, flags?: string): Promise<ManagedSession> {
    const id = randomBytes(4).toString('hex');
    const tmuxTarget = await tmux.createSession(id, cwd, name, flags);
    const session: ManagedSession = {
      id,
      name,
      tmuxSession: 'remote-claude',
      tmuxTarget,
      status: 'idle',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      cwd,
      flags,
    };
    this.sessions.set(id, session);
    this.save();
    this.onSessionUpdate(session);
    return session;
  }

  /** Delete a session, kill its tmux window. */
  async remove(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    const target = session.tmuxTarget;
    if (target) {
      try {
        await tmux.killWindow(target);
      } catch {
        // Window may already be dead
      }
    }
    this.sessions.delete(id);
    this.save();
    return true;
  }

  /** Dismiss a session from the dashboard (no tmux action). */
  dismiss(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    this.save();
    return true;
  }

  /** Close a session by killing its tmux window and removing it. */
  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    const target = session.tmuxTarget;
    if (target) {
      try {
        await tmux.killWindow(target);
      } catch {
        // Window may already be dead
      }
    }
    this.sessions.delete(id);
    this.save();
    return true;
  }

  /** Resolve the tmux target for a session (tmuxTarget > tmuxSession). */
  private resolveTarget(session: ManagedSession): string {
    const target = session.tmuxTarget || session.tmuxSession;
    if (!target) throw new Error('Session has no tmux target — cannot deliver commands');
    return target;
  }

  /** Send a prompt to a session's tmux pane. */
  async sendPrompt(id: string, text: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (session.status === 'offline') throw new Error('Session is offline');
    await tmux.sendPrompt(this.resolveTarget(session), text);
  }

  /** Send raw tmux keys to a session's pane. */
  async sendKeys(id: string, keys: string[]): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (session.status === 'offline') throw new Error('Session is offline');
    await tmux.sendKeys(this.resolveTarget(session), ...keys);
  }

  /** Send Ctrl+C to a session. */
  async sendCancel(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (session.status === 'offline') throw new Error('Session is offline');
    await tmux.sendCancel(this.resolveTarget(session));
  }

  /** Process an event and update session status accordingly. */
  handleEvent(event: ClaudeEvent): void {
    let session = this.findByEvent(event);

    // Auto-link: if we found a session by cwd but it doesn't have claudeSessionId yet, link it
    if (session && !session.claudeSessionId && event.sessionId) {
      session.claudeSessionId = event.sessionId;
    }

    // Auto-discover: create a session for unknown Claude Code instances
    if (!session && event.sessionId && event.sessionId !== 'unknown') {
      // Deduplicate by tmuxTarget: if another session already points to the
      // same pane, replace it (new Claude process reused the pane)
      if (event.tmuxTarget) {
        for (const [existingId, existing] of this.sessions.entries()) {
          if (existing.tmuxTarget === event.tmuxTarget && existing.claudeSessionId !== event.sessionId) {
            console.log(`[SessionManager] Replacing stale session ${existingId} on pane ${event.tmuxTarget}`);
            this.sessions.delete(existingId);
            this.onSessionRemoved(existingId);
            break;
          }
        }
      }

      const id = event.sessionId.slice(0, 8);
      const cwdName = event.cwd.split('/').pop() || 'unknown';
      const paneLabel = event.tmuxTarget || '';
      const name = paneLabel ? `${cwdName} (${paneLabel})` : cwdName;
      session = {
        id,
        name,
        tmuxSession: '', // not tmux-managed
        status: 'idle',
        createdAt: Date.now(),
        lastActivity: Date.now(),
        cwd: event.cwd,
        claudeSessionId: event.sessionId,
      };
      this.sessions.set(id, session);
      console.log(`[SessionManager] Auto-discovered session: ${name} (${id})`);
    }

    if (!session) return;

    // Keep tmuxTarget updated from latest events, and refresh name if it
    // doesn't include the pane label yet (backfill for old sessions)
    if (event.tmuxTarget && event.tmuxTarget !== session.tmuxTarget) {
      session.tmuxTarget = event.tmuxTarget;
      if (!session.name.includes('(')) {
        session.name = `${session.name} (${event.tmuxTarget})`;
      }
    }

    const prevStatus = session.status;
    session.lastActivity = Date.now();

    switch (event.type) {
      case 'user_prompt_submit':
        session.status = 'working';
        session.currentTool = undefined;
        session.lastAssistantText = undefined;
        session.permissionRequest = undefined;
        break;
      case 'pre_tool_use':
        session.status = 'working';
        session.currentTool = event.tool;
        session.permissionRequest = undefined;
        // Save assistant text from pre_tool_use (what Claude said before calling the tool)
        if (event.assistantText) {
          session.lastAssistantText = event.assistantText;
        }
        break;
      case 'post_tool_use':
        session.status = 'working';
        session.permissionRequest = undefined;
        break;
      case 'stop':
        session.status = 'idle';
        session.currentTool = undefined;
        session.permissionRequest = undefined;
        if (event.assistantText) {
          session.lastAssistantText = event.assistantText;
        }
        break;
      case 'notification':
        session.status = 'waiting';
        // Store structured permission request data for rich UI rendering
        if (event.tool && event.toolInput) {
          session.permissionRequest = { tool: event.tool, toolInput: event.toolInput };
        } else {
          session.permissionRequest = undefined;
        }
        // For notification events, build context from tool info if no assistantText.
        // This covers tool permission prompts (Bash, Edit, etc.) and AskUserQuestion.
        if (event.assistantText) {
          session.lastAssistantText = event.assistantText;
        } else if (event.tool && event.toolInput) {
          session.lastAssistantText = SessionManager.buildNotificationContext(event.tool, event.toolInput);
        }
        break;
      case 'session_start':
        session.status = 'idle';
        session.claudeSessionId = event.sessionId;
        session.permissionRequest = undefined;
        break;
      case 'session_end':
        session.status = 'idle';
        session.currentTool = undefined;
        session.permissionRequest = undefined;
        break;
    }

    if (event.marker) {
      session.lastMarker = event.marker;
    }

    // Update git info from events
    let metaChanged = false;
    if (event.gitBranch && (event.gitBranch !== session.gitBranch || event.gitDirty !== session.gitDirty)) {
      session.gitBranch = event.gitBranch;
      session.gitDirty = event.gitDirty;
      metaChanged = true;
    }

    // Update token count (sent on stop events)
    if (event.totalTokens != null && event.totalTokens !== session.totalTokens) {
      session.totalTokens = event.totalTokens;
      metaChanged = true;
    }

    // Update cwd if it changed
    if (event.cwd && event.cwd !== session.cwd) {
      session.cwd = event.cwd;
      metaChanged = true;
    }

    const changed = session.status !== prevStatus || event.marker || event.assistantText || metaChanged;
    if (changed) {
      this.save();
      this.onSessionUpdate(session);
    }
  }

  /** Start periodic health checks. */
  startHealthChecks(): void {
    this.healthCheck(); // Run once immediately
    this.healthInterval = setInterval(() => this.healthCheck(), HEALTH_CHECK_INTERVAL_MS);
    console.log(`[SessionManager] Health checks every ${HEALTH_CHECK_INTERVAL_MS}ms`);
  }

  stopHealthChecks(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private async healthCheck(): Promise<void> {
    // Get both session names and specific pane targets
    const liveSessions = await tmux.listSessions();
    const livePanes = await tmux.listPanes();
    const liveSessionSet = new Set(liveSessions);
    const livePaneSet = new Set(livePanes);
    let changed = false;

    const toRemove: string[] = [];

    for (const session of this.sessions.values()) {
      const isServerCreated = !!session.tmuxSession;
      let isAlive: boolean;

      if (session.tmuxTarget) {
        // Best check: verify the specific pane exists
        isAlive = livePaneSet.has(session.tmuxTarget);
      } else if (isServerCreated) {
        // Server-created sessions: check by managed tmux session name
        isAlive = liveSessionSet.has(session.tmuxSession);
      } else {
        // Auto-discovered without tmuxTarget (shouldn't happen normally):
        // give it a short grace period for initial events
        isAlive = Date.now() - session.lastActivity < 30_000;
      }

      // Read tmux window name for alive sessions with a target
      if (isAlive && session.tmuxTarget) {
        const winName = await tmux.getWindowName(session.tmuxTarget);
        if (winName && winName !== session.windowName) {
          session.windowName = winName;
          this.onSessionUpdate(session);
          changed = true;
        }
      }

      if (isAlive) {
        if (session.status === 'offline') {
          session.status = 'idle';
          session.lastActivity = Date.now();
          this.onSessionUpdate(session);
          changed = true;
        }
      } else {
        // Pane is gone — remove auto-discovered sessions immediately,
        // mark server-created ones offline
        if (!isServerCreated) {
          toRemove.push(session.id);
          changed = true;
        } else if (session.status !== 'offline') {
          session.status = 'offline';
          session.currentTool = undefined;
          this.onSessionUpdate(session);
          changed = true;
        }
      }

      // Working timeout: if working >2min without activity, set to idle
      if (
        session.status === 'working' &&
        Date.now() - session.lastActivity > WORKING_TIMEOUT_MS
      ) {
        session.status = 'idle';
        session.currentTool = undefined;
        this.onSessionUpdate(session);
        changed = true;
      }
    }

    // Remove dead auto-discovered sessions and broadcast removal
    for (const id of toRemove) {
      console.log(`[SessionManager] Removing dead session: ${id}`);
      this.sessions.delete(id);
      this.onSessionRemoved(id);
    }

    if (changed) this.save();
  }
}
