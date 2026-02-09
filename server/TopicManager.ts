// ============================================================
// TopicManager -- Telegram forum topic ↔ session mapping
// ============================================================

import type { Api } from 'grammy';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TELEGRAM_TOPICS_FILE } from '../shared/defaults.js';
import { getStatusEmoji } from './telegram-format.js';

interface TopicEntry {
  topicId: number;
  name: string;
  closed?: boolean;
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
          console.warn(
            `[Topics] Failed to reopen topic ${existing.topicId}:`,
            (err as Error).message || err,
          );
        }
      }
      return existing.topicId;
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
      return topicId;
    } catch (err) {
      console.error(
        `[Topics] Failed to create topic for "${displayName}":`,
        (err as Error).message || err,
      );
      return undefined;
    }
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
    // Move the entry to the new key
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
      console.warn(
        `[Topics] Failed to close topic ${entry.topicId}:`,
        (err as Error).message || err,
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
    this.lastTitle.set(sessionId, title);

    // Update base name in store
    if (entry.name !== displayName) {
      entry.name = displayName;
      this.save();
    }

    try {
      await this.api.editForumTopic(this.chatId, entry.topicId, { name: title });
    } catch (err) {
      console.warn(
        `[Topics] Failed to update topic title ${entry.topicId}:`,
        (err as Error).message || err,
      );
    }
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
