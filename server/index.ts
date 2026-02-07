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
import { mkdirSync } from 'node:fs';

const UPLOADS_DIR = join(DATA_DIR, 'uploads');

const VERSION = '0.1.0';
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

// Ensure data directories exist
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

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
});

const sessionManager = new SessionManager((session) => {
  broadcast({ type: 'session_update', payload: session });
});

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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
      'Access-Control-Allow-Origin': '*',
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
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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

    // Session-specific routes
    const route = parseSessionRoute(url);
    if (route) {
      const session = sessionManager.get(route.id);

      if (!route.action && method === 'DELETE') {
        const removed = await sessionManager.remove(route.id);
        if (!removed) return error(res, 'Session not found', 404);
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
        await sessionManager.sendPrompt(route.id, promptText);
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

      if (route.action === 'dismiss' && method === 'POST') {
        const dismissed = sessionManager.dismiss(route.id);
        if (!dismissed) return error(res, 'Session not found', 404);
        broadcast({ type: 'session_removed', payload: { sessionId: route.id } });
        return json(res, { ok: true });
      }

      if (route.action === 'close' && method === 'POST') {
        const closed = await sessionManager.close(route.id);
        if (!closed) return error(res, 'Session not found', 404);
        broadcast({ type: 'session_removed', payload: { sessionId: route.id } });
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
  for (const session of sessionManager.list()) {
    const sessionHistory = eventProcessor.getSessionHistory(session.id, 50);
    if (sessionHistory.length > 0) {
      send({ type: 'history', payload: sessionHistory });
    }
  }

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') {
        // No-op, keeps connection alive
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

server.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`[Server] Remote Claude v${VERSION} listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`[Server] Public dir: ${PUBLIC_DIR}`);
  console.log(`[Server] Data dir: ${DATA_DIR}`);
});
