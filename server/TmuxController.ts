// ============================================================
// TmuxController -- Safe tmux command wrappers
// ============================================================

import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { TMUX_SESSION_PREFIX } from '../shared/defaults.js';

const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const TMUX_TARGET_RE = /^[a-zA-Z0-9_:.\-]+$/;

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

export async function listManagedSessions(): Promise<string[]> {
  const all = await listSessions();
  return all.filter(name => name.startsWith(TMUX_SESSION_PREFIX));
}

export async function createSession(id: string, cwd: string): Promise<string> {
  const tmuxName = `${TMUX_SESSION_PREFIX}${id}`;
  validateSessionName(tmuxName);
  await execFileAsync('tmux', [
    'new-session', '-d',
    '-s', tmuxName,
    '-c', cwd,
    'claude', '--dangerously-skip-permissions',
  ]);
  return tmuxName;
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

export async function killSession(tmuxSession: string): Promise<void> {
  validateSessionName(tmuxSession);
  await execFileAsync('tmux', ['kill-session', '-t', tmuxSession]);
}
