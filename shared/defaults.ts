import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = join(homedir(), '.remote-claude', 'data');
export const HOOKS_DIR = join(homedir(), '.remote-claude', 'hooks');
export const EVENTS_FILE = join(DATA_DIR, 'events.jsonl');
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
export const AUTH_TOKEN_FILE = join(DATA_DIR, 'auth-token.txt');

export const SERVER_PORT = 4080;
export const HEALTH_CHECK_INTERVAL_MS = 5000;
export const WORKING_TIMEOUT_MS = 300_000; // 5 min — then verify via tmux pane
export const SESSION_OFFLINE_GRACE_MS = 30_000;
export const MAX_HISTORY_EVENTS = 200;
export const WS_PING_INTERVAL_MS = 30_000;

export const TMUX_SESSION_PREFIX = 'rc-'; // legacy, kept for reference
export const TMUX_SESSION_NAME = 'remote-claude';

// Telegram
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_TOPICS_FILE = join(DATA_DIR, 'telegram-topics.json');
export const TELEGRAM_GENERAL_TOPIC_ID = 1;
