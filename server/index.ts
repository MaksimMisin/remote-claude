// ============================================================
// Remote Claude Server -- Main entry point
// HTTP server, WebSocket, startup
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { SERVER_PORT, DATA_DIR } from '../shared/defaults.js';
import type { ClaudeEvent, ServerMessage } from '../shared/types.js';
import { SessionManager } from './SessionManager.js';
import { EventProcessor } from './EventProcessor.js';
import { PushManager } from './PushManager.js';
import { TelegramBot } from './TelegramBot.js';
import { capturePane } from './TmuxController.js';
import { mkdirSync } from 'node:fs';

const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

const UPLOADS_DIR = join(DATA_DIR, 'uploads');

const VERSION = '0.1.0';
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

// Ensure data directories exist
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const HOOK_SECRET_FILE = join(DATA_DIR, 'hook-secret.txt');

function getOrCreateHookSecret(): string {
  if (existsSync(HOOK_SECRET_FILE)) {
    return readFileSync(HOOK_SECRET_FILE, 'utf-8').trim();
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(HOOK_SECRET_FILE, secret, { mode: 0o600 });
  console.log(`[Server] Generated hook secret in ${HOOK_SECRET_FILE}`);
  return secret;
}

const HOOK_SECRET = getOrCreateHookSecret();

// --- WebSocket client management ---

const wsClients = new Set<WebSocket>();

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// --- Initialize components ---

const pushManager = new PushManager();

const eventProcessor = new EventProcessor((event: ClaudeEvent) => {
  broadcast({ type: 'event', payload: event });

  // If event has a marker, also broadcast a marker message
  if (event.marker) {
    broadcast({
      type: 'marker',
      payload: { sessionId: event.sessionId, marker: event.marker },
    });
  }

  // Update session status based on event
  sessionManager.handleEvent(event);

  // Stream events to Telegram topics
  if (telegramBot) {
    const session = sessionManager.findByEvent(event);
    if (session) {
      telegramBot.onEvent(event, session).catch((err) => {
        console.error('[Telegram] Event streaming error:', err);
      });
    }
  }
});

/** Track previous session statuses for notification transitions */
const prevStatuses = new Map<string, string>();

// --- Telegram bot (optional) ---

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_FORUM_MODE = (process.env.TELEGRAM_FORUM_MODE || 'auto') as 'auto' | 'true' | 'false';

let telegramBot: TelegramBot | null = null;

const sessionManager = new SessionManager(
  async (session) => {
    broadcast({ type: 'session_update', payload: session });

    // Track status transitions for push + telegram notifications
    const prev = prevStatuses.get(session.id) as import('../shared/types.js').SessionStatus | undefined;
    prevStatuses.set(session.id, session.status);

    const name = session.customName || session.name;
    const snippet = session.lastAssistantText
      ?.replace(/<!--rc:\w+:?[^>]*-->/g, '').trim().slice(0, 200) || '';

    // Push notifications
    if (prev === 'working' && session.status === 'waiting') {
      await pushManager.sendToAll({
        title: name + ' needs input',
        body: snippet || session.lastMarker?.message || 'Waiting for response',
        tag: 'rc-' + session.id,
        urgent: true,
      });
    } else if (prev === 'working' && session.status === 'idle') {
      await pushManager.sendToAll({
        title: name + ' finished',
        body: snippet || session.lastMarker?.message || 'Task complete',
        tag: 'rc-' + session.id,
        urgent: false,
      });
    } else if (session.status === 'waiting' && prev !== 'waiting' && prev !== undefined) {
      await pushManager.sendToAll({
        title: name + ' needs input',
        body: snippet || session.lastMarker?.message || 'Waiting for response',
        tag: 'rc-' + session.id,
        urgent: true,
      });
    }

    // Telegram notifications
    if (telegramBot) {
      await telegramBot.onStatusChange(prev, session);
    }
  },
  (sessionId) => {
    broadcast({ type: 'session_removed', payload: { sessionId } });
  },
  (oldSessionId, newSessionId, newSession) => {
    // Transfer Telegram topic from old session to new session (auto-continue on same pane)
    if (telegramBot) {
      telegramBot.onSessionReplaced(oldSessionId, newSessionId, newSession).catch((err) => {
        console.error('[Telegram] Topic transfer error:', err);
      });
    }
    // Transfer prevStatuses tracking
    const oldStatus = prevStatuses.get(oldSessionId);
    if (oldStatus) {
      prevStatuses.set(newSessionId, oldStatus);
      prevStatuses.delete(oldSessionId);
    }
  },
);

// --- HTTP helpers ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const limit = 10_000_000; // 10MB for image uploads
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

function serveStatic(res: ServerResponse, urlPath: string): void {
  let filePath = join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    error(res, 'Forbidden', 403);
    return;
  }

  // Try exact path, then with .html extension
  if (!existsSync(filePath) && !extname(filePath)) {
    filePath += '.html';
  }

  // SPA fallback: serve index.html for any non-file path
  if (!existsSync(filePath)) {
    filePath = join(PUBLIC_DIR, 'index.html');
  }

  if (!existsSync(filePath)) {
    error(res, 'Not found', 404);
    return;
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      ...SECURITY_HEADERS,
    });
    res.end(content);
  } catch {
    error(res, 'Internal server error', 500);
  }
}

// --- Extract session ID from URL like /api/sessions/:id/action ---

function parseSessionRoute(url: string): { id: string; action?: string } | null {
  const match = url.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)(?:\/(\w+))?$/);
  if (!match) return null;
  return { id: match[1], action: match[2] };
}

// --- HTTP server ---

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...SECURITY_HEADERS,
    });
    res.end();
    return;
  }

  // Request logging (skip noisy routes)
  if (url !== '/health' && !url.startsWith('/ws')) {
    console.log(`[HTTP] ${method} ${url}`);
  }

  try {
    // --- API routes ---

    if (url === '/health' && method === 'GET') {
      return json(res, {
        ok: true,
        version: VERSION,
        sessions: sessionManager.list().length,
        clients: wsClients.size,
      });
    }

    if (url === '/event' && method === 'POST') {
      // Block event ingestion from Cloudflare tunnel (external traffic)
      if (req.headers['cf-connecting-ip']) {
        return error(res, 'Forbidden', 403);
      }
      // Validate hook secret if provided (defense in depth)
      const hookSecret = req.headers['x-hook-secret'];
      if (hookSecret && hookSecret !== HOOK_SECRET) {
        return error(res, 'Invalid hook secret', 403);
      }
      const body = await readBody(req);
      const event = JSON.parse(body) as ClaudeEvent;
      if (!event.id || !event.type) {
        return error(res, 'Missing id or type');
      }
      const isNew = eventProcessor.ingest(event);
      return json(res, { ok: true, new: isNew });
    }

    if (url === '/api/debug' && method === 'GET') {
      return json(res, {
        sessions: sessionManager.list(),
        eventCount: eventProcessor.getEventCount(),
        recentEvents: eventProcessor.getHistory(10),
        uptime: process.uptime(),
        clients: wsClients.size,
      });
    }

    if (url === '/api/sessions' && method === 'GET') {
      return json(res, sessionManager.list());
    }

    if (url === '/api/sessions' && method === 'POST') {
      const body = await readBody(req);
      const { name, cwd, flags } = JSON.parse(body) as { name: string; cwd: string; flags?: string };
      if (!name || !cwd) {
        return error(res, 'Missing name or cwd');
      }
      const session = await sessionManager.create(name, cwd, flags);
      return json(res, session, 201);
    }

    if (url.startsWith('/api/directories') && method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const prefix = params.get('prefix') || '';
      const home = homedir();
      const allowedRoots = [home, '/tmp', '/var', '/opt', '/usr/local'];
      const targetPath = prefix ? resolve(prefix) : home;

      // Security: only allow paths under home or common code directories
      const isAllowed = allowedRoots.some(root => targetPath.startsWith(root));
      if (!isAllowed) {
        return json(res, { directories: [], base: targetPath });
      }

      try {
        const entries = readdirSync(targetPath, { withFileTypes: true });
        const directories = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => join(targetPath, e.name))
          .sort();
        return json(res, { directories, base: targetPath });
      } catch {
        // Permission denied, not found, etc.
        return json(res, { directories: [], base: targetPath });
      }
    }

    if (url === '/api/recent-dirs' && method === 'GET') {
      const cwds = new Set<string>();
      for (const session of sessionManager.list()) {
        if (session.cwd) cwds.add(session.cwd);
      }
      return json(res, { directories: Array.from(cwds) });
    }

    // --- Push notification routes ---

    if (url === '/api/push/vapid-key' && method === 'GET') {
      return json(res, { publicKey: pushManager.publicKey });
    }

    if (url === '/api/push/subscribe' && method === 'POST') {
      const body = await readBody(req);
      const subscription = JSON.parse(body);
      if (!subscription.endpoint || !subscription.keys) {
        return error(res, 'Invalid push subscription');
      }
      pushManager.subscribe(subscription);
      return json(res, { ok: true });
    }

    if (url === '/api/push/subscribe' && method === 'DELETE') {
      const body = await readBody(req);
      const { endpoint } = JSON.parse(body);
      if (!endpoint) return error(res, 'Missing endpoint');
      pushManager.unsubscribe(endpoint);
      return json(res, { ok: true });
    }

    // Session-specific routes
    const route = parseSessionRoute(url);
    if (route) {
      const session = sessionManager.get(route.id);

      if (!route.action && method === 'DELETE') {
        const sessionSnapshot = sessionManager.get(route.id);
        const removed = await sessionManager.remove(route.id);
        if (!removed) return error(res, 'Session not found', 404);
        if (telegramBot) telegramBot.onSessionRemoved(route.id, sessionSnapshot).catch(() => {});
        return json(res, { ok: true });
      }

      if (!session) return error(res, 'Session not found', 404);

      if (route.action === 'prompt' && method === 'POST') {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as {
          text?: string;
          image?: { name: string; base64: string; mimeType: string };
          images?: Array<{ name: string; base64: string; mimeType: string }>;
        };
        let promptText = parsed.text || '';

        // Collect images (single or multiple)
        const imageList = parsed.images || (parsed.image ? [parsed.image] : []);

        // Save each image and prepend references
        const refs: string[] = [];
        for (const img of imageList) {
          if (!img.base64) continue;
          const ext = img.mimeType === 'image/png' ? '.png'
            : img.mimeType === 'image/gif' ? '.gif'
            : img.mimeType === 'image/webp' ? '.webp'
            : '.jpg';
          const filename = `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
          const filepath = join(UPLOADS_DIR, filename);
          const buffer = Buffer.from(img.base64, 'base64');
          writeFileSync(filepath, buffer);
          console.log(`[Upload] Saved ${filepath} (${buffer.length} bytes)`);
          refs.push(`[User uploaded image: ${filepath}]`);
        }

        if (refs.length > 0) {
          promptText = refs.join('\n') + '\n' + promptText;
        }

        if (!promptText.trim()) return error(res, 'Missing text or image');

        const isSlashCmd = promptText.trim().startsWith('/');
        const tmuxTarget = session.tmuxTarget;

        // Capture pane before sending (for slash command output diffing)
        let paneBefore = '';
        if (isSlashCmd && tmuxTarget) {
          paneBefore = await capturePane(tmuxTarget);
        }

        await sessionManager.sendPrompt(route.id, promptText);

        // The UserPromptSubmit hook will fire and create the event naturally.
        // No synthetic event here — it caused duplicates with the hook event.

        // For slash commands: capture pane output after a delay and broadcast it
        if (isSlashCmd && tmuxTarget) {
          const sid = session.claudeSessionId || session.id;
          setTimeout(async () => {
            try {
              const paneAfter = await capturePane(tmuxTarget);
              // Strip ANSI escape codes
              const strip = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
              const beforeLines = strip(paneBefore).split('\n');
              const afterLines = strip(paneAfter).split('\n');

              // Find new lines by removing the common prefix
              let commonPrefix = 0;
              while (commonPrefix < beforeLines.length && commonPrefix < afterLines.length
                && beforeLines[commonPrefix] === afterLines[commonPrefix]) {
                commonPrefix++;
              }
              const newLines = afterLines.slice(commonPrefix)
                .filter(l => l.trim() !== '') // drop empty lines
                .join('\n').trim();

              if (newLines) {
                const responseEvent: ClaudeEvent = {
                  id: `web-resp-${Date.now()}-${randomBytes(4).toString('hex')}`,
                  timestamp: Date.now(),
                  type: 'stop',
                  sessionId: sid,
                  cwd: session.cwd,
                  assistantText: newLines,
                  tmuxTarget,
                };
                eventProcessor.ingest(responseEvent);
              }
            } catch (err) {
              console.error('[Server] Failed to capture slash command output:', err);
            }
          }, 1500);
        }

        return json(res, { ok: true });
      }

      if (route.action === 'keys' && method === 'POST') {
        const body = await readBody(req);
        const { keys } = JSON.parse(body) as { keys: string[] };
        if (!Array.isArray(keys) || keys.length === 0 || keys.length > 10) {
          return error(res, 'keys must be an array of 1-10 strings');
        }
        await sessionManager.sendKeys(route.id, keys);
        return json(res, { ok: true });
      }

      if (route.action === 'cancel' && method === 'POST') {
        await sessionManager.sendCancel(route.id);
        // Set a synthetic _cancelling tool so the frontend can show "Cancelling..."
        // The next real hook event will overwrite this.
        if (session.status === 'working') {
          session.currentTool = '_cancelling';
          broadcast({ type: 'session_update', payload: session });
        }
        return json(res, { ok: true });
      }

      if (route.action === 'rename' && method === 'POST') {
        const body = await readBody(req);
        const { name } = JSON.parse(body) as { name: string };
        if (name == null) return error(res, 'Missing name');
        const updated = await sessionManager.rename(route.id, name.trim());
        if (!updated) return error(res, 'Session not found', 404);
        return json(res, { ok: true });
      }

      if (route.action === 'dismiss' && method === 'POST') {
        const sessionSnapshot = session;
        const dismissed = sessionManager.dismiss(route.id);
        if (!dismissed) return error(res, 'Session not found', 404);
        broadcast({ type: 'session_removed', payload: { sessionId: route.id } });
        if (telegramBot) telegramBot.onSessionRemoved(route.id, sessionSnapshot).catch(() => {});
        return json(res, { ok: true });
      }

      if (route.action === 'close' && method === 'POST') {
        const sessionSnapshot = session;
        const closed = await sessionManager.close(route.id);
        if (!closed) return error(res, 'Session not found', 404);
        broadcast({ type: 'session_removed', payload: { sessionId: route.id } });
        if (telegramBot) telegramBot.onSessionRemoved(route.id, sessionSnapshot).catch(() => {});
        return json(res, { ok: true });
      }

      return error(res, 'Not found', 404);
    }

    // --- Static file serving ---
    serveStatic(res, url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error(`[Server] Error handling ${method} ${url}:`, message);
    error(res, message, 500);
  }
});

// --- WebSocket server ---

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket) => {
  wsClients.add(ws);
  console.log(`[WS] Client connected (${wsClients.size} total)`);

  // Send initial state
  const send = (msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  send({ type: 'connected', payload: { version: VERSION } });
  send({ type: 'sessions', payload: sessionManager.list() });
  // Send per-session history so no session gets starved
  // EventProcessor keys by shortId(claudeSessionId), which differs from
  // session.id for server-created sessions (random ID vs UUID prefix).
  for (const session of sessionManager.list()) {
    const historyKey = session.claudeSessionId
      ? session.claudeSessionId.slice(0, 8)
      : session.id;
    const sessionHistory = eventProcessor.getSessionHistory(historyKey, 50);
    if (sessionHistory.length > 0) {
      send({ type: 'history', payload: sessionHistory });
    }
  }

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') {
        // No-op, keeps connection alive
      } else if (msg.type === 'select_session' && msg.payload?.sessionId) {
        // Send history for the selected session
        const session = sessionManager.get(msg.payload.sessionId);
        if (session) {
          const historyKey = session.claudeSessionId
            ? session.claudeSessionId.slice(0, 8)
            : session.id;
          const history = eventProcessor.getSessionHistory(historyKey, 50);
          if (history.length > 0) {
            send({ type: 'history', payload: history });
          }
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected (${wsClients.size} total)`);
  });

  ws.on('error', () => {
    wsClients.delete(ws);
  });
});

// --- Startup ---

eventProcessor.startFileWatch();
sessionManager.startHealthChecks();

// Start Telegram bot if configured
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  telegramBot = new TelegramBot({
    token: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID,
    forumMode: TELEGRAM_FORUM_MODE,
    getSessions: () => sessionManager.list(),
    getSession: (id) => sessionManager.get(id),
    sendPrompt: (id, text) => sessionManager.sendPrompt(id, text),
    sendKeys: (id, keys) => sessionManager.sendKeys(id, keys),
  });
  telegramBot.start();
} else {
  console.log('[Server] Telegram not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable)');
}

server.listen(SERVER_PORT, BIND_HOST, () => {
  console.log(`[Server] Remote Claude v${VERSION} listening on http://${BIND_HOST}:${SERVER_PORT}`);
  console.log(`[Server] CORS origin: ${CORS_ORIGIN}`);
  console.log(`[Server] Public dir: ${PUBLIC_DIR}`);
  console.log(`[Server] Data dir: ${DATA_DIR}`);
});
