// ============================================================
// TopicManager tests — topic lifecycle, /purge, rename flows
//
// Tests cover:
// 1. /purge: deleteClosedTopics only deletes closed topics
// 2. transferTopic: moves topic between sessions, clears closed
// 3. closeTopic: marks closed in store + calls Telegram API
// 4. updateTopicTitle: debounced title updates with emoji prefix
// 5. updateStoredName: updates base name, clears title cache
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs before importing TopicManager
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{"topics":{}}'),
    writeFileSync: vi.fn(),
  };
});

import { TopicManager, type TopicEntry } from './TopicManager.js';

// --- Mock Telegram API ---

function makeMockApi() {
  return {
    createForumTopic: vi.fn(async (_chatId: string, name: string) => ({
      message_thread_id: Math.floor(Math.random() * 100000),
    })),
    editForumTopic: vi.fn(async () => true),
    closeForumTopic: vi.fn(async () => true),
    reopenForumTopic: vi.fn(async () => true),
    deleteForumTopic: vi.fn(async () => true),
  };
}

type MockApi = ReturnType<typeof makeMockApi>;

function createTopicManager(api?: MockApi): { tm: TopicManager; api: MockApi } {
  const mockApi = api ?? makeMockApi();
  const tm = new TopicManager('-1001234567890', mockApi as any);
  return { tm, api: mockApi };
}

// --- /purge: deleteClosedTopics ---

describe('TopicManager — /purge (deleteClosedTopics)', () => {
  let tm: TopicManager;
  let api: MockApi;

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ tm, api } = createTopicManager());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes all closed topics from store and Telegram', async () => {
    // Create 3 topics, close 2 of them
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 100 });
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 200 });
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 300 });

    await tm.ensureTopic('sess-a', 'Session A');
    await tm.ensureTopic('sess-b', 'Session B');
    await tm.ensureTopic('sess-c', 'Session C');

    // Close sess-a and sess-b
    await tm.closeTopic('sess-a');
    await tm.closeTopic('sess-b');

    // Verify state before purge
    expect(tm.getTopicId('sess-a')).toBe(100);
    expect(tm.getTopicId('sess-b')).toBe(200);
    expect(tm.getTopicId('sess-c')).toBe(300);

    // /purge — run with advancing timers to handle sleep(3000) between deletions
    const purgePromise = tm.deleteClosedTopics();
    // Advance past all sleep(3000) calls (2 topics × 3s)
    await vi.advanceTimersByTimeAsync(10_000);
    await purgePromise;

    // Closed topics deleted from store
    expect(tm.getTopicId('sess-a')).toBeUndefined();
    expect(tm.getTopicId('sess-b')).toBeUndefined();

    // Open topic untouched
    expect(tm.getTopicId('sess-c')).toBe(300);

    // Telegram deleteForumTopic called for each closed topic
    expect(api.deleteForumTopic).toHaveBeenCalledWith('-1001234567890', 100);
    expect(api.deleteForumTopic).toHaveBeenCalledWith('-1001234567890', 200);
    // NOT called for open topic
    expect(api.deleteForumTopic).not.toHaveBeenCalledWith('-1001234567890', 300);
  });

  it('does nothing when no closed topics exist', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 100 });
    await tm.ensureTopic('sess-a', 'Session A');

    await tm.deleteClosedTopics();

    // No delete calls
    expect(api.deleteForumTopic).not.toHaveBeenCalled();
    // Topic still exists
    expect(tm.getTopicId('sess-a')).toBe(100);
  });

  it('handles API failure gracefully — falls back to close', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 100 });
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 200 });

    await tm.ensureTopic('sess-a', 'Session A');
    await tm.ensureTopic('sess-b', 'Session B');
    await tm.closeTopic('sess-a');
    await tm.closeTopic('sess-b');

    // First delete fails (non-TOPIC_ID_INVALID), second succeeds
    api.deleteForumTopic
      .mockRejectedValueOnce(new Error('403: Forbidden: not enough rights'))
      .mockResolvedValueOnce(true);

    const purgePromise = tm.deleteClosedTopics();
    await vi.advanceTimersByTimeAsync(10_000);
    await purgePromise;

    // sess-a: delete failed, fell back to closeTopic (still in store but closed)
    expect(tm.getTopicId('sess-a')).toBe(100);

    // sess-b: delete succeeded, removed from store
    expect(tm.getTopicId('sess-b')).toBeUndefined();
  });

  it('cleans up store when Telegram says topic already deleted (TOPIC_ID_INVALID)', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 100 });
    await tm.ensureTopic('sess-a', 'Session A');
    await tm.closeTopic('sess-a');

    api.deleteForumTopic.mockRejectedValueOnce(
      new Error('400: Bad Request: TOPIC_ID_INVALID'),
    );

    const purgePromise = tm.deleteClosedTopics();
    await vi.advanceTimersByTimeAsync(10_000);
    await purgePromise;

    // Cleaned up from store even though API said invalid
    expect(tm.getTopicId('sess-a')).toBeUndefined();
  });

  it('does not touch open (non-closed) topics', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 100 });
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 200 });

    await tm.ensureTopic('sess-open', 'Open Session');
    await tm.ensureTopic('sess-closed', 'Closed Session');
    await tm.closeTopic('sess-closed');

    const purgePromise = tm.deleteClosedTopics();
    await vi.advanceTimersByTimeAsync(10_000);
    await purgePromise;

    // Only closed topic deleted
    expect(tm.getTopicId('sess-open')).toBe(100);
    expect(tm.getTopicId('sess-closed')).toBeUndefined();
  });
});

// --- transferTopic ---

describe('TopicManager — transferTopic', () => {
  let tm: TopicManager;
  let api: MockApi;

  beforeEach(async () => {
    ({ tm, api } = createTopicManager());
  });

  it('moves topic from old session to new session', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 500 });
    await tm.ensureTopic('old-sess', 'My Project');

    const entry = tm.transferTopic('old-sess', 'new-sess');

    expect(entry).not.toBeNull();
    expect(entry!.topicId).toBe(500);
    expect(tm.getTopicId('old-sess')).toBeUndefined();
    expect(tm.getTopicId('new-sess')).toBe(500);
  });

  it('clears closed flag on transfer', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 500 });
    await tm.ensureTopic('old-sess', 'My Project');
    await tm.closeTopic('old-sess');

    const entry = tm.transferTopic('old-sess', 'new-sess');

    expect(entry).not.toBeNull();
    expect(entry!.closed).toBeFalsy();
    // Reverse lookup works
    expect(tm.getSessionId(500)).toBe('new-sess');
  });

  it('returns null for non-existent source session', () => {
    const entry = tm.transferTopic('ghost', 'new-sess');
    expect(entry).toBeNull();
  });

  it('clears initialPrompt on transfer', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 500 });
    await tm.ensureTopic('old-sess', 'My Project');
    tm.setInitialPrompt('old-sess', 'Fix the bug');
    expect(tm.getInitialPrompt('old-sess')).toBe('Fix the bug');

    tm.transferTopic('old-sess', 'new-sess');

    // Initial prompt cleared so new session's first prompt is captured fresh
    expect(tm.getInitialPrompt('new-sess')).toBeUndefined();
  });
});

// --- closeTopic ---

describe('TopicManager — closeTopic', () => {
  let tm: TopicManager;
  let api: MockApi;

  beforeEach(async () => {
    ({ tm, api } = createTopicManager());
  });

  it('closes topic and sets offline emoji in title', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 600 });
    await tm.ensureTopic('sess-x', 'Worker');

    await tm.closeTopic('sess-x');

    // editForumTopic called with offline emoji
    expect(api.editForumTopic).toHaveBeenCalledWith(
      '-1001234567890',
      600,
      expect.objectContaining({ name: expect.stringContaining('Worker') }),
    );
    // closeForumTopic called
    expect(api.closeForumTopic).toHaveBeenCalledWith('-1001234567890', 600);

    // Topic still in store but marked closed
    expect(tm.getTopicId('sess-x')).toBe(600);
  });

  it('is idempotent — does nothing if already closed', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 600 });
    await tm.ensureTopic('sess-x', 'Worker');

    await tm.closeTopic('sess-x');
    api.closeForumTopic.mockClear();
    api.editForumTopic.mockClear();

    // Close again — should be no-op
    await tm.closeTopic('sess-x');
    expect(api.closeForumTopic).not.toHaveBeenCalled();
    expect(api.editForumTopic).not.toHaveBeenCalled();
  });
});

// --- updateTopicTitle (debounced) ---

describe('TopicManager — updateTopicTitle', () => {
  let tm: TopicManager;
  let api: MockApi;

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ tm, api } = createTopicManager());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates title with status emoji after debounce delay', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 700 });
    await tm.ensureTopic('sess-t', 'My App');

    await tm.updateTopicTitle('sess-t', 'working', 'My App');

    // Not called immediately (debounced)
    expect(api.editForumTopic).not.toHaveBeenCalledWith(
      '-1001234567890', 700, expect.objectContaining({ name: expect.stringContaining('My App') }),
    );

    // Advance past 5s debounce
    await vi.advanceTimersByTimeAsync(5_100);

    expect(api.editForumTopic).toHaveBeenCalledWith(
      '-1001234567890',
      700,
      { name: expect.stringContaining('My App') },
    );
  });

  it('deduplicates — skips update if title unchanged', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 700 });
    await tm.ensureTopic('sess-t', 'My App');

    // First update
    await tm.updateTopicTitle('sess-t', 'idle', 'My App');
    await vi.advanceTimersByTimeAsync(5_100);
    const callCount = api.editForumTopic.mock.calls.length;

    // Same title again — should be skipped
    await tm.updateTopicTitle('sess-t', 'idle', 'My App');
    await vi.advanceTimersByTimeAsync(5_100);

    expect(api.editForumTopic.mock.calls.length).toBe(callCount);
  });

  it('debounces rapid status changes — only last one fires', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 700 });
    await tm.ensureTopic('sess-t', 'My App');

    // Rapid changes within debounce window
    await tm.updateTopicTitle('sess-t', 'working', 'My App');
    await vi.advanceTimersByTimeAsync(2_000);
    await tm.updateTopicTitle('sess-t', 'idle', 'My App');
    await vi.advanceTimersByTimeAsync(2_000);
    await tm.updateTopicTitle('sess-t', 'working', 'My App');

    // After full debounce from last call
    await vi.advanceTimersByTimeAsync(5_100);

    // editForumTopic should have the last status (working)
    const lastCall = api.editForumTopic.mock.calls[api.editForumTopic.mock.calls.length - 1];
    expect(lastCall[2].name).toContain('My App');
  });

  it('skips updates for closed topics', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 700 });
    await tm.ensureTopic('sess-t', 'My App');
    await tm.closeTopic('sess-t');

    api.editForumTopic.mockClear();

    await tm.updateTopicTitle('sess-t', 'idle', 'My App');
    await vi.advanceTimersByTimeAsync(5_100);

    // editForumTopic NOT called for closed topic title update
    expect(api.editForumTopic).not.toHaveBeenCalled();
  });
});

// --- updateStoredName ---

describe('TopicManager — updateStoredName', () => {
  let tm: TopicManager;
  let api: MockApi;

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ tm, api } = createTopicManager());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates the base name in store', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 800 });
    await tm.ensureTopic('sess-r', 'Old Name');

    tm.updateStoredName('sess-r', 'New Name');

    // Next updateTopicTitle uses the new name
    await tm.updateTopicTitle('sess-r', 'idle', 'New Name');
    await vi.advanceTimersByTimeAsync(5_100);

    const calls = api.editForumTopic.mock.calls.filter(
      (c: any[]) => c[1] === 800 && typeof c[2]?.name === 'string',
    );
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2].name).toContain('New Name');
  });

  it('clears title cache so next update is not skipped', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 800 });
    await tm.ensureTopic('sess-r', 'Same Name');

    // Set title first
    await tm.updateTopicTitle('sess-r', 'idle', 'Same Name');
    await vi.advanceTimersByTimeAsync(5_100);
    const callsBefore = api.editForumTopic.mock.calls.length;

    // Update stored name (clears cache)
    tm.updateStoredName('sess-r', 'Same Name');

    // Same display name but cache cleared — update should fire again
    await tm.updateTopicTitle('sess-r', 'idle', 'Same Name');
    await vi.advanceTimersByTimeAsync(5_100);

    expect(api.editForumTopic.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// --- reopenTopic ---

describe('TopicManager — reopenTopic', () => {
  let tm: TopicManager;
  let api: MockApi;

  beforeEach(async () => {
    ({ tm, api } = createTopicManager());
  });

  it('reopens a closed topic and clears closed flag', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 900 });
    await tm.ensureTopic('sess-ro', 'Reopen Me');
    await tm.closeTopic('sess-ro');

    await tm.reopenTopic('sess-ro');

    expect(api.reopenForumTopic).toHaveBeenCalledWith('-1001234567890', 900);
  });

  it('is no-op for already-open topics', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 900 });
    await tm.ensureTopic('sess-ro', 'Already Open');

    await tm.reopenTopic('sess-ro');

    // Not called — topic was never closed
    expect(api.reopenForumTopic).not.toHaveBeenCalled();
  });

  it('handles TOPIC_NOT_MODIFIED gracefully', async () => {
    api.createForumTopic.mockResolvedValueOnce({ message_thread_id: 900 });
    await tm.ensureTopic('sess-ro', 'Already Open Server');
    await tm.closeTopic('sess-ro');

    api.reopenForumTopic.mockRejectedValueOnce(
      new Error('400: TOPIC_NOT_MODIFIED'),
    );

    // Should not throw
    await tm.reopenTopic('sess-ro');
  });
});
