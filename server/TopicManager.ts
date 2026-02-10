// ============================================================
// TopicManager -- Telegram forum topic ↔ session mapping
// ============================================================

import type { Api } from 'grammy';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TELEGRAM_TOPICS_FILE } from '../shared/defaults.js';
import { getStatusEmoji } from './telegram-format.js';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface TopicEntry {
  topicId: number;
  name: string;
  closed?: boolean;
  initialPrompt?: string;
}

interface TopicStore {
  topics: Record<string, TopicEntry>; // keyed by sessionId
  pinnedMessageId?: number;
}

export class TopicManager {
  private store: TopicStore = { topics: {} };
  private chatId: string;
  private api: Api;
  /** In-flight topic creation promises — prevents race-condition duplicates. */
  private pending = new Map<string, Promise<number | undefined>>();
  /** Initial prompt text waiting for topic creation (race: event arrives before topic). */
  private pendingInitialPrompt = new Map<string, string>();
  /** Per-session debounce timers for topic title updates. */
  private titleDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(chatId: string, api: Api) {
    this.chatId = chatId;
    this.api = api;
    this.load();
  }

  // -----------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------

  /**
   * Return the topicId for a session, creating a new forum topic if needed.
   * If the stored topic was previously closed, reopen it.
   * Returns undefined if topic creation fails.
   * Uses a per-session lock to prevent duplicate topic creation from concurrent calls.
   */
  async ensureTopic(
    sessionId: string,
    displayName: string,
  ): Promise<number | undefined> {
    // Fast path: already exists
    const existing = this.store.topics[sessionId];
    if (existing && !existing.closed) {
      return existing.topicId;
    }

    // If another call is already creating this topic, wait for it
    const inflight = this.pending.get(sessionId);
    if (inflight) return inflight;

    const promise = this._ensureTopicInner(sessionId, displayName);
    this.pending.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(sessionId);
    }
  }

  private async _ensureTopicInner(
    sessionId: string,
    displayName: string,
  ): Promise<number | undefined> {
    // Re-check after acquiring the "lock" — another call may have just created it
    const existing = this.store.topics[sessionId];

    if (existing) {
      // Reopen if it was closed
      if (existing.closed) {
        try {
          await this.api.reopenForumTopic(this.chatId, existing.topicId);
          existing.closed = false;
          existing.name = displayName;
          this.save();
          console.log(
            `[Topics] Reopened topic ${existing.topicId} for session ${sessionId}`,
          );
        } catch (err) {
          const msg = (err as Error).message || String(err);
          if (msg.includes('TOPIC_ID_INVALID')) {
            // Topic was deleted from Telegram — remove stale entry and fall through to create new
            console.log(`[Topics] Topic ${existing.topicId} no longer exists, will create new`);
            delete this.store.topics[sessionId];
            this.lastTitle.delete(sessionId);
            this.save();
            // Fall through to create a new topic below
          } else {
            console.warn(
              `[Topics] Failed to reopen topic ${existing.topicId}:`, msg,
            );
            return existing.topicId;
          }
        }
      }
      if (this.store.topics[sessionId]) {
        return existing.topicId;
      }
    }

    // Create a new forum topic
    try {
      const result = await this.api.createForumTopic(this.chatId, displayName);
      const topicId = result.message_thread_id;
      this.store.topics[sessionId] = {
        topicId,
        name: displayName,
      };
      this.save();
      console.log(
        `[Topics] Created topic ${topicId} "${displayName}" for session ${sessionId}`,
      );
      // Store pending initial prompt if a user_prompt_submit arrived before topic creation
      const pending = this.pendingInitialPrompt.get(sessionId);
      if (pending) {
        this.pendingInitialPrompt.delete(sessionId);
        this.store.topics[sessionId].initialPrompt = pending;
        this.save();
      }
      return topicId;
    } catch (err) {
      console.error(
        `[Topics] Failed to create topic for "${displayName}":`,
        (err as Error).message || err,
      );
      return undefined;
    }
  }

  /**
   * Store the initial user prompt for a session's topic (called on first user_prompt_submit).
   * Only stores once — subsequent prompts are ignored.
   * If the topic doesn't exist yet, queues the prompt for when it's created.
   */
  setInitialPrompt(sessionId: string, prompt: string): void {
    const entry = this.store.topics[sessionId];
    if (!entry) {
      // Topic not created yet — queue for later
      if (!this.pendingInitialPrompt.has(sessionId)) {
        this.pendingInitialPrompt.set(sessionId, prompt);
      }
      return;
    }
    if (entry.initialPrompt) return; // already set
    entry.initialPrompt = prompt;
    this.save();
  }

  /** Get the stored initial prompt for a session. */
  getInitialPrompt(sessionId: string): string | undefined {
    return this.store.topics[sessionId]?.initialPrompt;
  }

  /** Simple lookup: sessionId → topicId. */
  getTopicId(sessionId: string): number | undefined {
    return this.store.topics[sessionId]?.topicId;
  }

  /** Reverse lookup: topicId → sessionId. */
  getSessionId(topicId: number): string | undefined {
    for (const [sessionId, entry] of Object.entries(this.store.topics)) {
      if (entry.topicId === topicId) return sessionId;
    }
    return undefined;
  }

  /** Transfer a topic from one session to another (e.g., auto-continue on same pane). */
  transferTopic(fromSessionId: string, toSessionId: string): boolean {
    const entry = this.store.topics[fromSessionId];
    if (!entry) return false;
    // Move the entry to the new key, reset initial prompt so new session's first prompt is captured
    delete entry.initialPrompt;
    this.store.topics[toSessionId] = entry;
    delete this.store.topics[fromSessionId];
    this.lastTitle.delete(fromSessionId);
    this.save();
    console.log(
      `[Topics] Transferred topic ${entry.topicId} from session ${fromSessionId} → ${toSessionId}`,
    );
    return true;
  }

  /** Close a forum topic and mark it closed in the store. */
  async closeTopic(sessionId: string): Promise<void> {
    const entry = this.store.topics[sessionId];
    if (!entry || entry.closed) return;

    try {
      await this.api.closeForumTopic(this.chatId, entry.topicId);
      entry.closed = true;
      this.save();
      console.log(
        `[Topics] Closed topic ${entry.topicId} for session ${sessionId}`,
      );
    } catch (err) {
      const msg = (err as Error).message || String(err);
      // Topic was already deleted from Telegram — clean up our stale reference
      if (msg.includes('TOPIC_ID_INVALID') || msg.includes('TOPIC_NOT_MODIFIED')) {
        console.log(`[Topics] Topic ${entry.topicId} no longer exists, removing stale entry for session ${sessionId}`);
        delete this.store.topics[sessionId];
        this.lastTitle.delete(sessionId);
        this.save();
        return;
      }
      console.warn(
        `[Topics] Failed to close topic ${entry.topicId}:`, msg,
      );
    }
  }

  /** Delete a forum topic and remove it from the store entirely. */
  async deleteTopic(sessionId: string): Promise<void> {
    const entry = this.store.topics[sessionId];
    if (!entry) return;

    try {
      await this.api.deleteForumTopic(this.chatId, entry.topicId);
      console.log(
        `[Topics] Deleted topic ${entry.topicId} for session ${sessionId}`,
      );
    } catch (err) {
      console.warn(
        `[Topics] Failed to delete topic ${entry.topicId}:`,
        (err as Error).message || err,
      );
    }
    // Remove from store regardless — if API failed, the topic is orphaned anyway
    delete this.store.topics[sessionId];
    this.lastTitle.delete(sessionId);
    this.pendingInitialPrompt.delete(sessionId);
    this.save();
  }

  /** Delete all closed (inactive) topics from Telegram and the store. */
  async deleteClosedTopics(): Promise<void> {
    const closed = Object.entries(this.store.topics).filter(
      ([, e]) => e.closed,
    );
    if (closed.length === 0) return;
    console.log(`[Topics] Cleaning up ${closed.length} closed topic(s)...`);
    for (const [sessionId] of closed) {
      await this.deleteTopic(sessionId);
      await sleep(3000);
    }
  }

  /**
   * Close topics for sessions that no longer exist.
   * Called on startup to sync Telegram topics with active sessions.
   */
  async closeStaleTopics(activeSessionIds: Set<string>): Promise<void> {
    const stale = Object.entries(this.store.topics).filter(
      ([sessionId, entry]) => !entry.closed && !activeSessionIds.has(sessionId),
    );
    if (stale.length === 0) {
      console.log('[Topics] No stale topics to close');
      return;
    }
    console.log(`[Topics] Closing ${stale.length} stale topic(s)...`);
    for (const [sessionId, entry] of stale) {
      console.log(`[Topics] Closing stale topic ${entry.topicId} "${entry.name}" (session ${sessionId})`);
      await this.closeTopic(sessionId);
      await sleep(3000);
    }
  }

  /** Last title set per topic — avoids redundant API calls. */
  private lastTitle = new Map<string, string>();

  /**
   * Update the topic title to include a status emoji prefix.
   * e.g. "🟢 my-project". Skips if the title hasn't changed.
   */
  async updateTopicTitle(
    sessionId: string,
    status: string,
    displayName: string,
  ): Promise<void> {
    const entry = this.store.topics[sessionId];
    if (!entry || entry.closed) return;

    const emoji = getStatusEmoji(status);
    const title = `${emoji} ${displayName}`;

    // Skip if unchanged
    if (this.lastTitle.get(sessionId) === title) return;

    // Update base name in store
    if (entry.name !== displayName) {
      entry.name = displayName;
      this.save();
    }

    // Debounce: cancel any pending update, schedule new one in 5s.
    // This prevents rapid idle↔working emoji flipping from burning API budget.
    const existing = this.titleDebounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    this.titleDebounceTimers.set(sessionId, setTimeout(async () => {
      this.titleDebounceTimers.delete(sessionId);
      // Re-check entry still exists and title still needs updating
      const currentEntry = this.store.topics[sessionId];
      if (!currentEntry || currentEntry.closed) return;
      if (this.lastTitle.get(sessionId) === title) return;

      try {
        await this.api.editForumTopic(this.chatId, currentEntry.topicId, { name: title });
        this.lastTitle.set(sessionId, title);
      } catch (err) {
        const msg = (err as Error).message || String(err);
        if (msg.includes('TOPIC_ID_INVALID')) {
          console.log(`[Topics] Topic ${currentEntry.topicId} no longer exists, removing stale entry for session ${sessionId}`);
          delete this.store.topics[sessionId];
          this.lastTitle.delete(sessionId);
          this.save();
          return;
        }
        this.lastTitle.delete(sessionId);
        console.warn(
          `[Topics] Failed to update topic title ${currentEntry.topicId}:`, msg,
        );
      }
    }, 5000));
  }

  // -----------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------

  private load(): void {
    try {
      if (existsSync(TELEGRAM_TOPICS_FILE)) {
        this.store = JSON.parse(readFileSync(TELEGRAM_TOPICS_FILE, 'utf-8'));
        const count = Object.keys(this.store.topics).length;
        console.log(`[Topics] Loaded ${count} topic mappings`);
      }
    } catch {
      // Start fresh on corruption
      this.store = { topics: {} };
    }
  }

  private save(): void {
    try {
      writeFileSync(
        TELEGRAM_TOPICS_FILE,
        JSON.stringify(this.store, null, 2),
      );
    } catch (err) {
      console.error('[Topics] Failed to save topic store:', err);
    }
  }
}
