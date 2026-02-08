// ============================================================
// PushManager -- Web Push subscription management and delivery
// ============================================================

import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../shared/defaults.js';

const VAPID_KEYS_FILE = join(DATA_DIR, 'vapid-keys.json');
const SUBSCRIPTIONS_FILE = join(DATA_DIR, 'push-subscriptions.json');

interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  urgent?: boolean;
}

export class PushManager {
  private subscriptions: PushSubscriptionJSON[] = [];
  private vapidPublicKey: string;

  constructor() {
    const keys = this.loadOrGenerateVapidKeys();
    this.vapidPublicKey = keys.publicKey;
    webpush.setVapidDetails(
      'mailto:noreply@remote-claude.local',
      keys.publicKey,
      keys.privateKey,
    );
    this.loadSubscriptions();
  }

  get publicKey(): string {
    return this.vapidPublicKey;
  }

  subscribe(sub: PushSubscriptionJSON): void {
    // Replace existing subscription with same endpoint
    this.subscriptions = this.subscriptions.filter(s => s.endpoint !== sub.endpoint);
    this.subscriptions.push(sub);
    this.saveSubscriptions();
    console.log(`[Push] Subscription added (${this.subscriptions.length} total)`);
  }

  unsubscribe(endpoint: string): void {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(s => s.endpoint !== endpoint);
    if (this.subscriptions.length < before) {
      this.saveSubscriptions();
      console.log(`[Push] Subscription removed (${this.subscriptions.length} total)`);
    }
  }

  async sendToAll(payload: PushPayload): Promise<void> {
    if (this.subscriptions.length === 0) return;
    console.log(`[Push] Sending to ${this.subscriptions.length} subscribers: ${payload.title}`);
    const data = JSON.stringify(payload);
    const stale: string[] = [];

    await Promise.allSettled(
      this.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, data, {
            urgency: payload.urgent ? 'high' : 'normal',
            TTL: 3600,
          });
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 410 || statusCode === 404) {
            stale.push(sub.endpoint);
          } else {
            console.warn('[Push] Send failed:', (err as Error).message || err);
          }
        }
      }),
    );

    if (stale.length > 0) {
      this.subscriptions = this.subscriptions.filter(
        s => !stale.includes(s.endpoint),
      );
      this.saveSubscriptions();
      console.log(`[Push] Removed ${stale.length} stale subscriptions`);
    }
  }

  private loadOrGenerateVapidKeys(): { publicKey: string; privateKey: string } {
    if (existsSync(VAPID_KEYS_FILE)) {
      try {
        return JSON.parse(readFileSync(VAPID_KEYS_FILE, 'utf-8'));
      } catch { /* regenerate */ }
    }
    const keys = webpush.generateVAPIDKeys();
    writeFileSync(
      VAPID_KEYS_FILE,
      JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }, null, 2),
      { mode: 0o600 },
    );
    console.log('[Push] Generated new VAPID keys');
    return keys;
  }

  private loadSubscriptions(): void {
    try {
      if (existsSync(SUBSCRIPTIONS_FILE)) {
        this.subscriptions = JSON.parse(readFileSync(SUBSCRIPTIONS_FILE, 'utf-8'));
        console.log(`[Push] Loaded ${this.subscriptions.length} subscriptions`);
      }
    } catch { /* start fresh */ }
  }

  private saveSubscriptions(): void {
    try {
      writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(this.subscriptions, null, 2));
    } catch (err) {
      console.error('[Push] Failed to save subscriptions:', err);
    }
  }
}
