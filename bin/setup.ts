#!/usr/bin/env tsx
// ============================================================
// Remote Claude -- Setup Script
// Installs hooks into Claude Code and generates auth token
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Paths ---
const HOME = homedir();
const RC_DIR = join(HOME, '.remote-claude');
const DATA_DIR = join(RC_DIR, 'data');
const HOOKS_DIR = join(RC_DIR, 'hooks');
const AUTH_TOKEN_FILE = join(DATA_DIR, 'auth-token.txt');

const CLAUDE_SETTINGS_PATH = join(HOME, '.claude', 'settings.json');
const HOOK_SOURCE = join(__dirname, '..', 'hooks', 'remote-claude-hook.sh');
const HOOK_DEST = join(HOOKS_DIR, 'remote-claude-hook.sh');
const RC_CLI_SOURCE = join(__dirname, 'rc');
const RC_CLI_DEST = join(RC_DIR, 'bin', 'rc');
const RC_CLI_BIN_DIR = join(RC_DIR, 'bin');
const PROJECT_DIR = join(__dirname, '..');
const PROJECT_DIR_FILE = join(RC_DIR, 'project-dir');

const HOOK_COMMAND = '~/.remote-claude/hooks/remote-claude-hook.sh';
const SERVER_PORT = 4080;

const EVENT_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Notification',
] as const;

// --- Helpers ---

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function logStep(msg: string): void {
  console.log(`\n> ${msg}`);
}

function logOk(msg: string): void {
  console.log(`  [OK] ${msg}`);
}

function logSkip(msg: string): void {
  console.log(`  [SKIP] ${msg}`);
}

function logWarn(msg: string): void {
  console.log(`  [WARN] ${msg}`);
}

function getLocalIP(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// --- Step 1: Create directories ---

function createDirectories(): void {
  logStep('Creating directories');

  for (const dir of [DATA_DIR, HOOKS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      logOk(`Created ${dir}`);
    } else {
      logSkip(`${dir} already exists`);
    }
  }
}

// --- Step 2: Copy hook script ---

function installHookScript(): void {
  logStep('Installing hook script');

  if (!existsSync(HOOK_SOURCE)) {
    logWarn(`Hook source not found at ${HOOK_SOURCE}`);
    logWarn('Make sure hooks/remote-claude-hook.sh exists in the project');
    return;
  }

  copyFileSync(HOOK_SOURCE, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  logOk(`Copied hook script to ${HOOK_DEST}`);
  logOk('Made executable (chmod 755)');
}

// --- Step 3: Install rc CLI ---

function installCli(): void {
  logStep('Installing rc CLI');

  if (!existsSync(RC_CLI_SOURCE)) {
    logWarn(`CLI source not found at ${RC_CLI_SOURCE}`);
    return;
  }

  if (!existsSync(RC_CLI_BIN_DIR)) {
    mkdirSync(RC_CLI_BIN_DIR, { recursive: true });
  }

  copyFileSync(RC_CLI_SOURCE, RC_CLI_DEST);
  chmodSync(RC_CLI_DEST, 0o755);
  logOk(`Copied rc CLI to ${RC_CLI_DEST}`);

  // Save project directory so rc can start the server
  const resolvedProjectDir = join(__dirname, '..');
  writeFileSync(PROJECT_DIR_FILE, resolvedProjectDir + '\n');
  logOk(`Saved project dir to ${PROJECT_DIR_FILE}`);

  // Symlink to /usr/local/bin if possible
  const symlinkPath = '/usr/local/bin/rc';
  try {
    if (existsSync(symlinkPath)) {
      unlinkSync(symlinkPath);
    }
    symlinkSync(RC_CLI_DEST, symlinkPath);
    logOk(`Symlinked to ${symlinkPath}`);
  } catch {
    logWarn(`Could not symlink to ${symlinkPath} (may need sudo)`);
    log(`Add to PATH manually: export PATH="$HOME/.remote-claude/bin:$PATH"`);
  }
}

// --- Step 4: Register hooks in Claude settings ---

function registerHooks(): void {
  logStep('Registering hooks in Claude Code settings');

  // Ensure ~/.claude/ directory exists
  const claudeDir = dirname(CLAUDE_SETTINGS_PATH);
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
    logOk(`Created ${claudeDir}`);
  }

  // Load existing settings or start fresh
  let settings: Record<string, unknown> = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    // Back up existing settings
    const backupPath = `${CLAUDE_SETTINGS_PATH}.backup-${Date.now()}`;
    copyFileSync(CLAUDE_SETTINGS_PATH, backupPath);
    logOk(`Backed up existing settings to ${backupPath}`);

    const raw = readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(raw);
  } else {
    logOk('No existing settings.json found, creating new one');
  }

  // Ensure hooks object exists
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  const hooks = settings.hooks as Record<string, unknown[]>;

  const ourHookEntry = {
    matcher: '',
    hooks: [
      { type: 'command', command: HOOK_COMMAND },
    ],
  };

  let added = 0;
  let skipped = 0;

  for (const eventType of EVENT_TYPES) {
    // Ensure the event type has an array
    if (!Array.isArray(hooks[eventType])) {
      hooks[eventType] = [];
    }

    const entries = hooks[eventType] as Array<Record<string, unknown>>;

    // Check if our hook is already registered
    const alreadyRegistered = entries.some((entry) => {
      const entryHooks = entry.hooks;
      if (!Array.isArray(entryHooks)) return false;
      return entryHooks.some(
        (h: Record<string, unknown>) =>
          h.type === 'command' && h.command === HOOK_COMMAND,
      );
    });

    if (alreadyRegistered) {
      logSkip(`${eventType}: hook already registered`);
      skipped++;
    } else {
      entries.push(ourHookEntry);
      logOk(`${eventType}: hook added`);
      added++;
    }
  }

  // Write updated settings
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  logOk(`Settings saved (${added} added, ${skipped} already present)`);
}

// --- Step 5: Generate auth token ---

function generateAuthToken(): string {
  logStep('Generating auth token');

  if (existsSync(AUTH_TOKEN_FILE)) {
    const existing = readFileSync(AUTH_TOKEN_FILE, 'utf-8').trim();
    if (existing.length >= 32) {
      logSkip('Auth token already exists, keeping it');
      return existing;
    }
  }

  const token = randomBytes(32).toString('hex');
  writeFileSync(AUTH_TOKEN_FILE, token + '\n', { mode: 0o600 });
  logOk(`Auth token generated and saved to ${AUTH_TOKEN_FILE}`);
  logOk('File permissions set to 0600 (owner read/write only)');
  return token;
}

// --- Step 6: Print access info ---

function printAccessInfo(token: string): void {
  const ip = getLocalIP();
  const url = `http://${ip}:${SERVER_PORT}?token=${token}`;

  console.log('\n' + '='.repeat(60));
  console.log('  Remote Claude Setup Complete');
  console.log('='.repeat(60));
  console.log();
  console.log('  Server URL:');
  console.log(`    http://localhost:${SERVER_PORT}`);
  console.log();
  console.log('  Mobile Access URL (same network):');
  console.log(`    ${url}`);
  console.log();
  console.log('  Auth Token:');
  console.log(`    ${token}`);
  console.log();
  console.log('  To start the server:');
  console.log('    npm run dev    (with hot reload)');
  console.log('    npm run start  (production)');
  console.log();
  console.log('  Toggle hooks + server:');
  console.log('    rc off         (pause hooks & kill server)');
  console.log('    rc on          (resume hooks)');
  console.log('    rc             (show status)');
  console.log();
  console.log('  Open the Mobile Access URL on your phone to connect.');
  console.log('  Make sure your phone is on the same WiFi network.');
  console.log();
  console.log('  For remote access, consider using Tailscale:');
  console.log('    https://tailscale.com');
  console.log();
  console.log('='.repeat(60));
}

// --- Main ---

function main(): void {
  console.log('\n  Remote Claude -- Setup\n');

  try {
    createDirectories();
    installHookScript();
    installCli();
    registerHooks();
    const token = generateAuthToken();
    printAccessInfo(token);
  } catch (err) {
    console.error('\n  [ERROR] Setup failed:', err);
    process.exit(1);
  }
}

main();
