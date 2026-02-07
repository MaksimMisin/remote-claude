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

  constructor(onSessionUpdate: (session: ManagedSession) => void) {
    this.onSessionUpdate = onSessionUpdate;
    this.load();
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
    // First try exact sessionId match
    for (const s of this.sessions.values()) {
      if (s.claudeSessionId && s.claudeSessionId === event.sessionId) return s;
    }
    // Then try cwd match
    for (const s of this.sessions.values()) {
      if (s.cwd === event.cwd && s.status !== 'offline') return s;
    }
    return undefined;
  }

  /** Create a new session, spawn tmux. */
  async create(name: string, cwd: string): Promise<ManagedSession> {
    const id = randomBytes(4).toString('hex');
    const tmuxSession = await tmux.createSession(id, cwd);
    const session: ManagedSession = {
      id,
      name,
      tmuxSession,
      status: 'idle',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      cwd,
    };
    this.sessions.set(id, session);
    this.save();
    this.onSessionUpdate(session);
    return session;
  }

  /** Delete a session, kill tmux. */
  async remove(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    try {
      await tmux.killSession(session.tmuxSession);
    } catch {
      // tmux session may already be dead
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
      const id = event.sessionId.slice(0, 8);
      const cwdName = event.cwd.split('/').pop() || 'unknown';
      session = {
        id,
        name: cwdName,
        tmuxSession: '', // not tmux-managed
        status: 'idle',
        createdAt: Date.now(),
        lastActivity: Date.now(),
        cwd: event.cwd,
        claudeSessionId: event.sessionId,
      };
      this.sessions.set(id, session);
      console.log(`[SessionManager] Auto-discovered session: ${cwdName} (${id})`);
    }

    if (!session) return;

    // Keep tmuxTarget updated from latest events
    if (event.tmuxTarget && event.tmuxTarget !== session.tmuxTarget) {
      session.tmuxTarget = event.tmuxTarget;
    }

    const prevStatus = session.status;
    session.lastActivity = Date.now();

    switch (event.type) {
      case 'user_prompt_submit':
        session.status = 'working';
        session.currentTool = undefined;
        break;
      case 'pre_tool_use':
        session.status = 'working';
        session.currentTool = event.tool;
        break;
      case 'post_tool_use':
        session.status = 'working';
        break;
      case 'stop':
        session.status = 'idle';
        session.currentTool = undefined;
        break;
      case 'notification':
        session.status = 'waiting';
        break;
      case 'session_start':
        session.status = 'idle';
        session.claudeSessionId = event.sessionId;
        break;
      case 'session_end':
        session.status = 'idle';
        session.currentTool = undefined;
        break;
    }

    if (event.marker) {
      session.lastMarker = event.marker;
    }

    if (session.status !== prevStatus || event.marker) {
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
    const liveSessions = await tmux.listSessions();
    const liveSet = new Set(liveSessions);
    let changed = false;

    for (const session of this.sessions.values()) {
      // Auto-discovered sessions: check by tmuxTarget (e.g. "Personal:6.0")
      const isAutoDiscovered = !session.tmuxSession;
      const tmuxSessionName = session.tmuxTarget?.split(':')[0] || session.tmuxSession;
      const isAlive = isAutoDiscovered
        ? (tmuxSessionName && liveSet.has(tmuxSessionName)) || Date.now() - session.lastActivity < WORKING_TIMEOUT_MS
        : liveSet.has(session.tmuxSession);

      if (isAlive) {
        if (session.status === 'offline') {
          session.status = 'idle';
          session.lastActivity = Date.now();
          this.onSessionUpdate(session);
          changed = true;
        }
      } else {
        if (session.status !== 'offline') {
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

    if (changed) this.save();
  }
}
