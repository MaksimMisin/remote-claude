// ============================================================
// SessionManager tests — session replacement & session_end timer
//
// These tests verify that:
// 1. /clear and clean-context plan restarts TRANSFER the session
//    (onSessionReplaced) instead of REMOVING it (onSessionRemoved).
//    This is critical for Telegram topic continuity.
// 2. The session_end timer marks sessions offline after 5s
//    when no session_start follows (e.g., /exit).
// 3. The timer is cancelled when session_start arrives quickly
//    (e.g., /clear, clean-context plan restart).
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and TmuxController before importing SessionManager
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false), // No sessions file on disk
    readFileSync: vi.fn(() => '[]'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
  };
});

vi.mock('./TmuxController.js', () => ({
  listSessions: vi.fn(async () => []),
  listPanes: vi.fn(async () => []),
  createWindow: vi.fn(async () => 'remote-claude:0.0'),
  killWindow: vi.fn(async () => {}),
  sendPrompt: vi.fn(async () => {}),
  sendKeys: vi.fn(async () => {}),
  sendCancel: vi.fn(async () => {}),
  isActivelyWorking: vi.fn(async () => false),
  renameWindow: vi.fn(async () => {}),
  getWindowName: vi.fn(async () => null),
}));

import { SessionManager } from './SessionManager.js';
import * as tmux from './TmuxController.js';
import type { ClaudeEvent, ManagedSession } from '../shared/types.js';

// --- Helpers ---

function makeEvent(overrides: Partial<ClaudeEvent>): ClaudeEvent {
  return {
    id: 'test-event',
    timestamp: Date.now(),
    type: 'session_start',
    sessionId: 'aaaa-bbbb',
    cwd: '/tmp/test',
    ...overrides,
  };
}

describe('SessionManager — session replacement', () => {
  let sm: SessionManager;
  let updates: ManagedSession[];
  let removals: string[];
  let replacements: Array<{ oldId: string; newId: string; newSession: ManagedSession }>;

  beforeEach(() => {
    vi.useFakeTimers();
    updates = [];
    removals = [];
    replacements = [];
    sm = new SessionManager(
      (session) => { updates.push({ ...session }); },
      (sessionId) => { removals.push(sessionId); },
      (oldId, newId, newSession) => { replacements.push({ oldId, newId, newSession }); },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-discovers a session from its first event', () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'aaaa-1111-2222-3333-444444444444',
      tmuxTarget: 'Personal:2.0',
    }));
    const sessions = sm.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('aaaa-111');  // first 8 chars truncated to 7? no: slice(0,8) = 'aaaa-111'
  });

  it('transfers (not removes) the session when a new Claude session starts on the same pane', () => {
    // Session A starts
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'aaaa-1111-2222-3333-444444444444',
      tmuxTarget: 'Personal:2.0',
      cwd: '/tmp/project',
    }));
    expect(sm.list()).toHaveLength(1);
    const oldId = sm.list()[0].id;

    // Session A ends (e.g., /clear fires session_end)
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'aaaa-1111-2222-3333-444444444444',
      tmuxTarget: 'Personal:2.0',
    }));

    // Session B starts on the SAME pane (~100ms later)
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'bbbb-5555-6666-7777-888888888888',
      tmuxTarget: 'Personal:2.0',
      cwd: '/tmp/project',
    }));

    // Should have exactly 1 session (B replaced A)
    expect(sm.list()).toHaveLength(1);
    const newId = sm.list()[0].id;
    expect(newId).not.toBe(oldId);

    // onSessionRemoved should NOT have been called (topic would be deleted!)
    expect(removals).toHaveLength(0);

    // onSessionReplaced SHOULD have been called (topic transfer)
    expect(replacements).toHaveLength(1);
    expect(replacements[0].oldId).toBe(oldId);
    expect(replacements[0].newId).toBe(newId);
  });

  it('preserves topic across /clear (session_end → immediate session_start)', () => {
    // Initial session
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'aaaa-1111-2222-3333-444444444444',
      tmuxTarget: 'Test:0.0',
    }));
    const firstId = sm.list()[0].id;

    // /clear: session_end then session_start with new ID
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'aaaa-1111-2222-3333-444444444444',
      tmuxTarget: 'Test:0.0',
    }));
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'cccc-9999-aaaa-bbbb-cccccccccccc',
      tmuxTarget: 'Test:0.0',
    }));

    // Verify: 1 session, replacement happened, no removal
    expect(sm.list()).toHaveLength(1);
    expect(sm.list()[0].id).not.toBe(firstId);
    expect(removals).toHaveLength(0);
    expect(replacements).toHaveLength(1);

    // session_end timer should have been cancelled (no offline after 5s)
    vi.advanceTimersByTime(10_000);
    expect(sm.list()[0].status).not.toBe('offline');
  });

  it('preserves topic across clean-context plan restart (identical to /clear)', () => {
    // Plan session starts
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'plan-1111-2222-3333-444444444444',
      tmuxTarget: 'Work:3.0',
      cwd: '/home/user/myproject',
    }));

    // User works, then approves plan with "clear context"
    sm.handleEvent(makeEvent({
      type: 'user_prompt_submit',
      sessionId: 'plan-1111-2222-3333-444444444444',
      tmuxTarget: 'Work:3.0',
    }));
    sm.handleEvent(makeEvent({
      type: 'stop',
      sessionId: 'plan-1111-2222-3333-444444444444',
      tmuxTarget: 'Work:3.0',
    }));

    // Clean-context restart: session_end → session_start with new ID
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'plan-1111-2222-3333-444444444444',
      tmuxTarget: 'Work:3.0',
    }));
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'impl-5555-6666-7777-888888888888',
      tmuxTarget: 'Work:3.0',
      cwd: '/home/user/myproject',
    }));

    // Verify: topic transferred, not deleted
    expect(sm.list()).toHaveLength(1);
    expect(removals).toHaveLength(0);
    expect(replacements).toHaveLength(1);
    expect(replacements[0].oldId).toBe('plan-111');
    expect(replacements[0].newId).toBe('impl-555');

    // Timer cancelled — session stays alive
    vi.advanceTimersByTime(10_000);
    expect(sm.list()[0].status).not.toBe('offline');
  });
});

describe('SessionManager — session_end offline timer', () => {
  let sm: SessionManager;
  let updates: ManagedSession[];

  beforeEach(() => {
    vi.useFakeTimers();
    updates = [];
    sm = new SessionManager(
      (session) => { updates.push({ ...session }); },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks session offline 5s after session_end with no session_start', () => {
    // Session starts
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'exit-1111-2222-3333-444444444444',
      tmuxTarget: 'Personal:0.0',
    }));
    expect(sm.list()[0].status).toBe('idle');

    // Do some work
    sm.handleEvent(makeEvent({
      type: 'user_prompt_submit',
      sessionId: 'exit-1111-2222-3333-444444444444',
      tmuxTarget: 'Personal:0.0',
    }));
    expect(sm.list()[0].status).toBe('working');

    sm.handleEvent(makeEvent({
      type: 'stop',
      sessionId: 'exit-1111-2222-3333-444444444444',
      tmuxTarget: 'Personal:0.0',
    }));
    expect(sm.list()[0].status).toBe('idle');

    // /exit fires session_end
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'exit-1111-2222-3333-444444444444',
      tmuxTarget: 'Personal:0.0',
    }));
    expect(sm.list()[0].status).toBe('idle'); // Still idle immediately

    // After 4s — still idle
    vi.advanceTimersByTime(4_000);
    expect(sm.list()[0].status).toBe('idle');

    // After 5s total — now offline with claudeExited flag
    vi.advanceTimersByTime(1_000);
    expect(sm.list()[0].status).toBe('offline');
    expect(sm.list()[0].claudeExited).toBe(true);
  });

  it('cancels the offline timer when session_start arrives on same pane', () => {
    // Session starts
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'clear-1111-2222-3333-444444444444',
      tmuxTarget: 'Dev:1.0',
    }));

    // session_end (from /clear)
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'clear-1111-2222-3333-444444444444',
      tmuxTarget: 'Dev:1.0',
    }));

    // New session_start on same pane (100ms later in real life)
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'fresh-5555-6666-7777-888888888888',
      tmuxTarget: 'Dev:1.0',
    }));

    // Even after 10s, should NOT be offline (timer was cancelled)
    vi.advanceTimersByTime(10_000);
    const session = sm.list().find(s => s.tmuxTarget === 'Dev:1.0');
    expect(session).toBeDefined();
    expect(session!.status).not.toBe('offline');
  });

  it('does not start timer for sessions without tmuxTarget', () => {
    // Edge case: session without tmuxTarget
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'notm-1111-2222-3333-444444444444',
      // no tmuxTarget
    }));

    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'notm-1111-2222-3333-444444444444',
    }));

    // After 10s — still idle (no timer was started)
    vi.advanceTimersByTime(10_000);
    expect(sm.list()[0].status).toBe('idle');
  });
});

describe('SessionManager — multiple replacements preserve continuity', () => {
  let sm: SessionManager;
  let removals: string[];
  let replacements: Array<{ oldId: string; newId: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    removals = [];
    replacements = [];
    sm = new SessionManager(
      () => {},
      (id) => { removals.push(id); },
      (oldId, newId) => { replacements.push({ oldId, newId }); },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles chain of /clear operations without ever calling onSessionRemoved', () => {
    const pane = 'Personal:5.0';

    // Session 1
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'sess1-aaa-bbb-ccc-ddddddddddddd',
      tmuxTarget: pane,
    }));

    // /clear → session 2
    sm.handleEvent(makeEvent({ type: 'session_end', sessionId: 'sess1-aaa-bbb-ccc-ddddddddddddd', tmuxTarget: pane }));
    sm.handleEvent(makeEvent({ type: 'session_start', sessionId: 'sess2-eee-fff-ggg-hhhhhhhhhhhhh', tmuxTarget: pane }));

    // /clear → session 3
    sm.handleEvent(makeEvent({ type: 'session_end', sessionId: 'sess2-eee-fff-ggg-hhhhhhhhhhhhh', tmuxTarget: pane }));
    sm.handleEvent(makeEvent({ type: 'session_start', sessionId: 'sess3-iii-jjj-kkk-lllllllllllll', tmuxTarget: pane }));

    // /clear → session 4
    sm.handleEvent(makeEvent({ type: 'session_end', sessionId: 'sess3-iii-jjj-kkk-lllllllllllll', tmuxTarget: pane }));
    sm.handleEvent(makeEvent({ type: 'session_start', sessionId: 'sess4-mmm-nnn-ooo-ppppppppppppp', tmuxTarget: pane }));

    // Should have exactly 1 session, 3 replacements, 0 removals
    expect(sm.list()).toHaveLength(1);
    expect(replacements).toHaveLength(3);
    expect(removals).toHaveLength(0);

    // No offline after waiting
    vi.advanceTimersByTime(30_000);
    expect(sm.list()[0].status).not.toBe('offline');
  });
});

describe('SessionManager — health check respects claudeExited', () => {
  let sm: SessionManager;
  let removals: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    removals = [];
    sm = new SessionManager(
      () => {},
      (id) => { removals.push(id); },
    );
  });

  afterEach(() => {
    sm.stopHealthChecks();
    vi.useRealTimers();
  });

  it('does NOT revive a session after /exit even if pane is alive', async () => {
    // Session starts on a pane
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'hc-exit-1111-2222-333333333333',
      tmuxTarget: 'Personal:3.0',
    }));
    expect(sm.list()[0].status).toBe('idle');

    // /exit → session_end → timer fires → offline + claudeExited
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'hc-exit-1111-2222-333333333333',
      tmuxTarget: 'Personal:3.0',
    }));
    vi.advanceTimersByTime(5_000);
    expect(sm.list()[0].status).toBe('offline');
    expect(sm.list()[0].claudeExited).toBe(true);

    // Health check: pane IS alive (shell still running)
    vi.mocked(tmux.listPanes).mockResolvedValueOnce(['Personal:3.0']);
    vi.mocked(tmux.listSessions).mockResolvedValueOnce(['Personal']);
    sm.startHealthChecks();
    await vi.advanceTimersByTimeAsync(5_100);

    // Session must STAY offline — health check must not revive it
    const session = sm.list().find(s => s.tmuxTarget === 'Personal:3.0');
    expect(session).toBeDefined();
    expect(session!.status).toBe('offline');
  });

  it('removes session after grace period even when pane is alive (claudeExited)', async () => {
    // Session starts
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'hc-rm-11111-2222-333333333333',
      tmuxTarget: 'Personal:4.0',
    }));
    const sessionId = sm.list()[0].id;

    // /exit → offline + claudeExited
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'hc-rm-11111-2222-333333333333',
      tmuxTarget: 'Personal:4.0',
    }));
    vi.advanceTimersByTime(5_000);
    expect(sm.list()[0].status).toBe('offline');

    // Fast-forward past the grace period (30s).
    // Each health check needs the mock — set up for multiple calls.
    vi.mocked(tmux.listPanes).mockResolvedValue(['Personal:4.0']);
    vi.mocked(tmux.listSessions).mockResolvedValue(['Personal']);
    sm.startHealthChecks();
    await vi.advanceTimersByTimeAsync(35_000);

    // Session should be removed — onSessionRemoved called
    expect(removals).toContain(sessionId);
    expect(sm.list().find(s => s.id === sessionId)).toBeUndefined();
  });

  it('/clear does NOT set claudeExited — health check can revive', () => {
    // Session starts
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'hc-clr-1111-2222-333333333333',
      tmuxTarget: 'Dev:0.0',
    }));

    // /clear: session_end → session_start
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'hc-clr-1111-2222-333333333333',
      tmuxTarget: 'Dev:0.0',
    }));
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'hc-clr-5555-6666-777777777777',
      tmuxTarget: 'Dev:0.0',
    }));

    // New session should NOT have claudeExited
    const session = sm.list().find(s => s.tmuxTarget === 'Dev:0.0');
    expect(session).toBeDefined();
    expect(session!.claudeExited).toBeFalsy();
    expect(session!.status).toBe('idle');
  });
});
