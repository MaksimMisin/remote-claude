// ============================================================
// Logger -- Tee console output to a rotating log file
// 5MB max per file, 1 backup (server.log -> server.log.1)
// ============================================================

import { createWriteStream, statSync, renameSync, mkdirSync, existsSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { LOGS_DIR } from '../shared/defaults.js';

const LOG_FILE = join(LOGS_DIR, 'server.log');
const BACKUP_FILE = join(LOGS_DIR, 'server.log.1');
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

let stream: WriteStream;
let currentSize = 0;

function openStream(): WriteStream {
  const s = createWriteStream(LOG_FILE, { flags: 'a' });
  s.on('error', () => {
    // If logging itself fails, don't crash the server
  });
  return s;
}

function rotate(): void {
  try {
    stream.end();
    if (existsSync(BACKUP_FILE)) {
      // Remove old backup (renameSync overwrites on POSIX)
    }
    renameSync(LOG_FILE, BACKUP_FILE);
  } catch {
    // Best effort
  }
  stream = openStream();
  currentSize = 0;
}

function writeLine(line: string): void {
  const buf = line + '\n';
  stream.write(buf);
  currentSize += Buffer.byteLength(buf);
  if (currentSize >= MAX_BYTES) {
    rotate();
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

export function initLogger(): void {
  mkdirSync(LOGS_DIR, { recursive: true });

  // Get current file size if it exists
  try {
    currentSize = statSync(LOG_FILE).size;
    if (currentSize >= MAX_BYTES) {
      // Rotate before opening
      try {
        renameSync(LOG_FILE, BACKUP_FILE);
      } catch { /* best effort */ }
      currentSize = 0;
    }
  } catch {
    currentSize = 0;
  }

  stream = openStream();

  const debugEnabled = process.env.RC_DEBUG === '1' || process.env.RC_DEBUG === 'true';

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  const origDebug = console.debug.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeLine(`${timestamp()} [LOG] ${args.map(String).join(' ')}`);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    writeLine(`${timestamp()} [ERR] ${args.map(String).join(' ')}`);
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeLine(`${timestamp()} [WRN] ${args.map(String).join(' ')}`);
  };

  console.debug = (...args: unknown[]) => {
    // Always write to log file, only print to console if RC_DEBUG is enabled
    writeLine(`${timestamp()} [DBG] ${args.map(String).join(' ')}`);
    if (debugEnabled) {
      origDebug(...args);
    }
  };

  writeLine(`${timestamp()} [LOG] --- Logger initialized (debug=${debugEnabled}) ---`);
}
