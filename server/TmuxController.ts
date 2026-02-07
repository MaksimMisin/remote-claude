// ============================================================
// TmuxController -- Safe tmux command wrappers
// ============================================================

import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { TMUX_SESSION_NAME } from '../shared/defaults.js';

const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const TMUX_TARGET_RE = /^[a-zA-Z0-9_:.\- ]+$/;

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`);
  }
}

function validateTarget(target: string): void {
  if (!target || !TMUX_TARGET_RE.test(target)) {
    throw new Error(`Invalid tmux target: ${target}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function listSessions(): Promise<string[]> {
  try {
    const stdout = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    // tmux returns error if no server is running
    return [];
  }
}

/** List all tmux panes as "session:window.pane" targets. */
export async function listPanes(): Promise<string[]> {
  try {
    const stdout = await execFileAsync('tmux', [
      'list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}',
    ]);
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Validate and parse a flags string into an array of safe CLI flags. */
function parseFlags(flags: string): string[] {
  const parts = flags.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (!part.startsWith('-')) {
      throw new Error(`Invalid flag (must start with - or --): ${part}`);
    }
    // Block shell metacharacters
    if (/[;&|`$(){}!<>]/.test(part)) {
      throw new Error(`Invalid characters in flag: ${part}`);
    }
  }
  return parts;
}

/** Check if the shared tmux session exists. */
async function sessionExists(): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.includes(TMUX_SESSION_NAME);
}

/**
 * Create a new window in the shared remote-claude tmux session.
 * If the session doesn't exist, creates it with this window as the first.
 * Returns the tmux target (e.g. "remote-claude:1.0").
 */
export async function createSession(id: string, cwd: string, windowName: string, flags?: string): Promise<string> {
  const claudeArgs = flags ? parseFlags(flags) : ['--dangerously-skip-permissions'];
  const exists = await sessionExists();

  if (!exists) {
    // Create the session with this window as the initial window
    const stdout = await execFileAsync('tmux', [
      'new-session', '-d',
      '-s', TMUX_SESSION_NAME,
      '-n', windowName,
      '-c', cwd,
      '-P', '-F', '#{session_name}:#{window_index}.#{pane_index}',
      'claude', ...claudeArgs,
    ]);
    return stdout.trim();
  }

  // Session already exists — add a new window
  const stdout = await execFileAsync('tmux', [
    'new-window', '-t', TMUX_SESSION_NAME,
    '-n', windowName,
    '-c', cwd,
    '-P', '-F', '#{session_name}:#{window_index}.#{pane_index}',
    'claude', ...claudeArgs,
  ]);
  return stdout.trim();
}

export async function sendPrompt(tmuxSession: string, text: string): Promise<void> {
  validateTarget(tmuxSession);
  const tempFile = `/tmp/rc-prompt-${Date.now()}-${randomBytes(8).toString('hex')}.txt`;
  writeFileSync(tempFile, text);
  try {
    await execFileAsync('tmux', ['load-buffer', tempFile]);
    await execFileAsync('tmux', ['paste-buffer', '-t', tmuxSession]);
    await sleep(100);
    await execFileAsync('tmux', ['send-keys', '-t', tmuxSession, 'Enter']);
  } finally {
    try { unlinkSync(tempFile); } catch {}
  }
}

export async function sendCancel(tmuxSession: string): Promise<void> {
  validateTarget(tmuxSession);
  await execFileAsync('tmux', ['send-keys', '-t', tmuxSession, 'C-c']);
}

export async function getWindowName(target: string): Promise<string> {
  validateTarget(target);
  try {
    const name = await execFileAsync('tmux', ['display-message', '-t', target, '-p', '#W']);
    return name.trim();
  } catch {
    return '';
  }
}

export async function killWindow(target: string): Promise<void> {
  validateTarget(target);
  await execFileAsync('tmux', ['kill-window', '-t', target]);
}

/** Allowed tmux key names for sendKeys (prevents injection). */
const ALLOWED_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'BTab', 'Space', 'BSpace',
  'Up', 'Down', 'Left', 'Right',
  'C-c', 'C-d', 'C-z',
]);

export async function sendKeys(target: string, ...keys: string[]): Promise<void> {
  validateTarget(target);
  for (const key of keys) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Disallowed tmux key: ${key}`);
    }
    await execFileAsync('tmux', ['send-keys', '-t', target, key]);
    await sleep(50);
  }
}

export async function killSession(tmuxSession: string): Promise<void> {
  validateSessionName(tmuxSession);
  await execFileAsync('tmux', ['kill-session', '-t', tmuxSession]);
}
