// ============================================================
// EventProcessor -- Event ingestion, dedup, history, file watch
// ============================================================

import { watch } from 'chokidar';
import { readFileSync, existsSync } from 'node:fs';
import { EVENTS_FILE, MAX_HISTORY_EVENTS } from '../shared/defaults.js';
import type { ClaudeEvent } from '../shared/types.js';
import { parseMarker } from './MarkerParser.js';

export class EventProcessor {
  /** Events stored per session (short ID → events array) */
  private sessionEvents = new Map<string, ClaudeEvent[]>();
  private seenIds = new Set<string>();
  private fileOffset = 0;
  private onEvent: (event: ClaudeEvent) => void;

  private static readonly MAX_PER_SESSION = 100;

  constructor(onEvent: (event: ClaudeEvent) => void) {
    this.onEvent = onEvent;
  }

  /** Get the short session ID (first 8 chars of Claude session UUID). */
  private shortId(sessionId: string): string {
    return sessionId.slice(0, 8);
  }

  /** Process an incoming event (from HTTP POST). Returns true if new. */
  ingest(event: ClaudeEvent): boolean {
    if (this.seenIds.has(event.id)) return false;
    this.seenIds.add(event.id);

    // Parse marker from assistant text if present and not already set
    if (!event.marker && event.assistantText) {
      const marker = parseMarker(event.assistantText);
      if (marker) event.marker = marker;
    }

    const sid = this.shortId(event.sessionId);
    let bucket = this.sessionEvents.get(sid);
    if (!bucket) {
      bucket = [];
      this.sessionEvents.set(sid, bucket);
    }
    bucket.push(event);
    if (bucket.length > EventProcessor.MAX_PER_SESSION) {
      bucket.shift();
    }

    // Trim seenIds periodically
    if (this.seenIds.size > EventProcessor.MAX_PER_SESSION * this.sessionEvents.size * 3) {
      const keep = new Set<string>();
      for (const evts of this.sessionEvents.values()) {
        for (const e of evts) keep.add(e.id);
      }
      this.seenIds = keep;
    }

    this.onEvent(event);
    return true;
  }

  /** Return last N events across all sessions, merged and sorted. */
  getHistory(limit = 50): ClaudeEvent[] {
    const all: ClaudeEvent[] = [];
    for (const evts of this.sessionEvents.values()) {
      all.push(...evts);
    }
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all.slice(-limit);
  }

  /** Return events for a specific session (by short ID). */
  getSessionHistory(sessionId: string, limit = 100): ClaudeEvent[] {
    return (this.sessionEvents.get(sessionId) || []).slice(-limit);
  }

  /** Return total number of events tracked in memory. */
  getEventCount(): number {
    let count = 0;
    for (const evts of this.sessionEvents.values()) count += evts.length;
    return count;
  }

  /** Start watching the JSONL events file for crash recovery. */
  startFileWatch(): void {
    // Seed the offset to end of current file so we don't replay old events
    if (existsSync(EVENTS_FILE)) {
      try {
        const content = readFileSync(EVENTS_FILE, 'utf-8');
        this.fileOffset = content.length;
      } catch {}
    }

    const watcher = watch(EVENTS_FILE, {
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    watcher.on('change', () => {
      this.readNewLines();
    });

    watcher.on('add', () => {
      this.readNewLines();
    });

    console.log(`[EventProcessor] Watching ${EVENTS_FILE}`);
  }

  private readNewLines(): void {
    try {
      const content = readFileSync(EVENTS_FILE, 'utf-8');
      if (content.length <= this.fileOffset) return;

      const newContent = content.slice(this.fileOffset);
      this.fileOffset = content.length;

      const lines = newContent.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as ClaudeEvent;
          if (event.id) this.ingest(event);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File may have been deleted/rotated
    }
  }
}
