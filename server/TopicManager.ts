// ============================================================
// TopicManager -- Telegram forum topic ↔ session mapping
// ============================================================

import type { Api } from 'grammy';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TELEGRAM_TOPICS_FILE } from '../shared/defaults.js';

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
      // Rename topic if display name changed
      if (displayName && existing.name !== displayName) {
        this.renameTopic(sessionId, displayName);
      }
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

  /** Rename a topic in Telegram and update the store (fire-and-forget). */
  private renameTopic(sessionId: string, newName: string): void {
    const entry = this.store.topics[sessionId];
    if (!entry) return;

    // Update store immediately so we don't retry on every call
    const oldName = entry.name;
    entry.name = newName;
    this.save();

    this.api
      .editForumTopic(this.chatId, entry.topicId, { name: newName })
      .then(() => {
        console.log(
          `[Topics] Renamed topic ${entry.topicId} "${oldName}" → "${newName}"`,
        );
      })
      .catch((err) => {
        console.warn(
          `[Topics] Failed to rename topic ${entry.topicId}:`,
          (err as Error).message || err,
        );
      });
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

  /** Getter for the pinned status message ID. */
  get pinnedMessageId(): number | undefined {
    return this.store.pinnedMessageId;
  }

  /** Setter for the pinned status message ID (auto-saves). */
  set pinnedMessageId(id: number | undefined) {
    this.store.pinnedMessageId = id;
    this.save();
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
