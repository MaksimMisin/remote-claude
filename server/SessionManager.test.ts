// ============================================================
// SessionManager tests — session lifecycle, replacement, rename
//
// These tests verify that:
// 1. /clear and clean-context plan restarts TRANSFER the session
//    (onSessionReplaced) instead of REMOVING it (onSessionRemoved).
// 2. The session_end timer marks sessions offline after 5s
//    when no session_start follows (e.g., /exit).
// 3. The timer is cancelled when session_start arrives quickly.
// 4. rename() sets/clears customName with correct priority.
// 5. Health check detects tmux window name changes.
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

// ============================================================
// Rename flows
// ============================================================

describe('SessionManager — rename (customName)', () => {
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

  it('sets customName on the session', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'rn-aaa-1111-2222-333333333333',
      tmuxTarget: 'Work:0.0',
      cwd: '/tmp/project',
    }));
    const sessionId = sm.list()[0].id;

    const result = await sm.rename(sessionId, 'My Custom Name');

    expect(result).toBeDefined();
    expect(result!.customName).toBe('My Custom Name');
    // onSessionUpdate fired
    const lastUpdate = updates[updates.length - 1];
    expect(lastUpdate.customName).toBe('My Custom Name');
  });

  it('also renames the tmux window', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'rn-bbb-1111-2222-333333333333',
      tmuxTarget: 'Work:1.0',
      cwd: '/tmp/project',
    }));
    const sessionId = sm.list()[0].id;

    await sm.rename(sessionId, 'Tmux Rename');

    expect(tmux.renameWindow).toHaveBeenCalledWith('Work:1.0', 'Tmux Rename');
  });

  it('clears customName when given empty string', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'rn-ccc-1111-2222-333333333333',
      tmuxTarget: 'Work:2.0',
      cwd: '/tmp/project',
    }));
    const sessionId = sm.list()[0].id;

    // Set then clear
    await sm.rename(sessionId, 'Pinned');
    expect(sm.list()[0].customName).toBe('Pinned');

    await sm.rename(sessionId, '');
    expect(sm.list()[0].customName).toBeUndefined();
  });

  it('returns undefined for non-existent session', async () => {
    const result = await sm.rename('ghost-id', 'Name');
    expect(result).toBeUndefined();
  });

  it('customName survives session events (not overwritten by hook data)', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'rn-ddd-1111-2222-333333333333',
      tmuxTarget: 'Work:3.0',
      cwd: '/tmp/project',
    }));
    const sessionId = sm.list()[0].id;

    await sm.rename(sessionId, 'Sticky Name');

    // More events come in — customName must not be cleared
    sm.handleEvent(makeEvent({
      type: 'user_prompt_submit',
      sessionId: 'rn-ddd-1111-2222-333333333333',
      tmuxTarget: 'Work:3.0',
    }));
    sm.handleEvent(makeEvent({
      type: 'pre_tool_use',
      sessionId: 'rn-ddd-1111-2222-333333333333',
      tmuxTarget: 'Work:3.0',
      tool: 'Bash',
    }));
    sm.handleEvent(makeEvent({
      type: 'stop',
      sessionId: 'rn-ddd-1111-2222-333333333333',
      tmuxTarget: 'Work:3.0',
    }));

    expect(sm.list()[0].customName).toBe('Sticky Name');
  });

  it('tmux rename failure is non-fatal — customName still set', async () => {
    vi.mocked(tmux.renameWindow).mockRejectedValueOnce(new Error('tmux: no such window'));

    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'rn-eee-1111-2222-333333333333',
      tmuxTarget: 'Work:4.0',
      cwd: '/tmp/project',
    }));
    const sessionId = sm.list()[0].id;

    const result = await sm.rename(sessionId, 'Still Works');

    expect(result).toBeDefined();
    expect(result!.customName).toBe('Still Works');
  });
});

// ============================================================
// Health check — window name detection
// ============================================================

describe('SessionManager — health check window name', () => {
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
    sm.stopHealthChecks();
    vi.useRealTimers();
  });

  it('detects window name change from tmux', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'wn-aaa-1111-2222-333333333333',
      tmuxTarget: 'Dev:0.0',
      cwd: '/tmp/project',
    }));
    expect(sm.list()[0].windowName).toBeUndefined();

    // Health check returns window name
    vi.mocked(tmux.listPanes).mockResolvedValue(['Dev:0.0']);
    vi.mocked(tmux.listSessions).mockResolvedValue(['Dev']);
    vi.mocked(tmux.getWindowName).mockResolvedValue('🤖 auth fix');

    sm.startHealthChecks();
    await vi.advanceTimersByTimeAsync(5_100);

    expect(sm.list()[0].windowName).toBe('🤖 auth fix');
    // onSessionUpdate was called with the new name
    const nameUpdate = updates.find(u => u.windowName === '🤖 auth fix');
    expect(nameUpdate).toBeDefined();
  });

  it('fires onSessionUpdate when window name changes', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'wn-bbb-1111-2222-333333333333',
      tmuxTarget: 'Dev:1.0',
      cwd: '/tmp/project',
    }));

    vi.mocked(tmux.listPanes).mockResolvedValue(['Dev:1.0']);
    vi.mocked(tmux.listSessions).mockResolvedValue(['Dev']);

    // First name
    vi.mocked(tmux.getWindowName).mockResolvedValueOnce('🤖 first task');
    sm.startHealthChecks();
    await vi.advanceTimersByTimeAsync(5_100);

    updates.length = 0; // Clear previous updates

    // Name changes
    vi.mocked(tmux.getWindowName).mockResolvedValueOnce('✅ first task done');
    await vi.advanceTimersByTimeAsync(5_100);

    expect(sm.list()[0].windowName).toBe('✅ first task done');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some(u => u.windowName === '✅ first task done')).toBe(true);
  });

  it('does NOT update when window name is unchanged', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'wn-ccc-1111-2222-333333333333',
      tmuxTarget: 'Dev:2.0',
      cwd: '/tmp/project',
    }));

    vi.mocked(tmux.listPanes).mockResolvedValue(['Dev:2.0']);
    vi.mocked(tmux.listSessions).mockResolvedValue(['Dev']);
    vi.mocked(tmux.getWindowName).mockResolvedValue('stable-name');

    sm.startHealthChecks();
    await vi.advanceTimersByTimeAsync(5_100);

    const updateCountAfterFirst = updates.length;

    // Second health check — same name
    await vi.advanceTimersByTimeAsync(5_100);

    // No new update for unchanged name (only status-related updates possible)
    const nameUpdates = updates.slice(updateCountAfterFirst).filter(
      u => u.windowName === 'stable-name',
    );
    // The update from windowName should not fire again
    expect(nameUpdates.length).toBe(0);
  });

  it('does not read window name for offline sessions', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'wn-ddd-1111-2222-333333333333',
      tmuxTarget: 'Dev:3.0',
      cwd: '/tmp/project',
    }));

    // Pane is gone
    vi.mocked(tmux.listPanes).mockResolvedValue([]);
    vi.mocked(tmux.listSessions).mockResolvedValue(['Dev']);
    vi.mocked(tmux.getWindowName).mockClear();

    sm.startHealthChecks();
    await vi.advanceTimersByTimeAsync(5_100);

    // getWindowName should NOT be called for dead pane
    expect(tmux.getWindowName).not.toHaveBeenCalled();
  });
});

// ============================================================
// customName priority over windowName across session lifecycle
// ============================================================

describe('SessionManager — customName vs windowName priority', () => {
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
    sm.stopHealthChecks();
    vi.useRealTimers();
  });

  it('customName is preserved when health check updates windowName', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'prio-aaa-1111-222233333333',
      tmuxTarget: 'Work:0.0',
      cwd: '/tmp/project',
    }));
    const sessionId = sm.list()[0].id;

    // Set customName (user renamed in Telegram/Dashboard)
    await sm.rename(sessionId, 'Pinned Name');

    // Health check changes windowName
    vi.mocked(tmux.listPanes).mockResolvedValue(['Work:0.0']);
    vi.mocked(tmux.listSessions).mockResolvedValue(['Work']);
    vi.mocked(tmux.getWindowName).mockResolvedValue('🤖 auto generated');

    sm.startHealthChecks();
    await vi.advanceTimersByTimeAsync(5_100);

    const session = sm.list()[0];
    // windowName updated
    expect(session.windowName).toBe('🤖 auto generated');
    // customName NOT overwritten
    expect(session.customName).toBe('Pinned Name');
  });

  it('clearing customName reverts display to windowName', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'prio-bbb-1111-222233333333',
      tmuxTarget: 'Work:1.0',
      cwd: '/tmp/project',
    }));
    const sessionId = sm.list()[0].id;

    // Set both names
    await sm.rename(sessionId, 'Pinned');

    vi.mocked(tmux.listPanes).mockResolvedValue(['Work:1.0']);
    vi.mocked(tmux.listSessions).mockResolvedValue(['Work']);
    vi.mocked(tmux.getWindowName).mockResolvedValue('auto-name');
    sm.startHealthChecks();
    await vi.advanceTimersByTimeAsync(5_100);

    // Both set
    expect(sm.list()[0].customName).toBe('Pinned');
    expect(sm.list()[0].windowName).toBe('auto-name');

    // Clear customName
    await sm.rename(sessionId, '');

    const session = sm.list()[0];
    expect(session.customName).toBeUndefined();
    // windowName is still there as fallback
    expect(session.windowName).toBe('auto-name');
  });

  it('session replacement preserves nothing — new session starts fresh', async () => {
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'prio-ccc-1111-222233333333',
      tmuxTarget: 'Work:2.0',
      cwd: '/tmp/project',
    }));
    const sessionId = sm.list()[0].id;
    await sm.rename(sessionId, 'Old Pin');

    // /clear → replacement
    sm.handleEvent(makeEvent({
      type: 'session_end',
      sessionId: 'prio-ccc-1111-222233333333',
      tmuxTarget: 'Work:2.0',
    }));
    sm.handleEvent(makeEvent({
      type: 'session_start',
      sessionId: 'prio-ddd-5555-666677777777',
      tmuxTarget: 'Work:2.0',
      cwd: '/tmp/project',
    }));

    const newSession = sm.list()[0];
    // New session does NOT inherit customName from old session
    // (Topic transfer handles naming in TelegramBot, not SessionManager)
    expect(newSession.customName).toBeUndefined();
  });
});
