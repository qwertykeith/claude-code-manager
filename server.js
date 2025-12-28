#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { findAvailablePort } = require('./lib/port-finder');
const { SessionManager } = require('./lib/session-manager');
const { UsageTracker, PLAN_LIMITS } = require('./lib/usage-tracker');

const DEV_MODE = process.argv.includes('--dev');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const LIB_DIR = path.join(__dirname, 'lib');

async function main() {
  const port = await findAvailablePort(3001);
  const sessionManager = new SessionManager();
  const usageTracker = new UsageTracker();

  // Initialize sessions (start fresh)
  await sessionManager.loadSessions();

  // HTTP server for static files (no caching in dev mode)
  const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    filePath = path.join(PUBLIC_DIR, filePath);

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const headers = { 'Content-Type': contentType };
      if (DEV_MODE) {
        headers['Cache-Control'] = 'no-store';
      }
      res.writeHead(200, headers);
      res.end(content);
    });
  });

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on('connection', async (ws) => {
    // Send current sessions on connect
    ws.send(JSON.stringify({
      type: 'sessions',
      sessions: sessionManager.getAllSessions(),
    }));

    // Send usage data on connect
    const usage = await usageTracker.getUsage();
    ws.send(JSON.stringify({ type: 'usage', usage, planLimits: PLAN_LIMITS }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg, sessionManager, wss);
      } catch (e) {
        console.error('Invalid message:', e);
      }
    });

    ws.on('close', () => {
      // Client disconnected
    });
  });

  // Broadcast helper
  sessionManager.on('update', () => {
    broadcast(wss, {
      type: 'sessions',
      sessions: sessionManager.getAllSessions(),
    });
  });

  sessionManager.on('output', ({ sessionId, data }) => {
    broadcast(wss, { type: 'output', sessionId, data });
  });

  sessionManager.on('status', ({ sessionId, status }) => {
    broadcast(wss, { type: 'status', sessionId, status });
  });

  sessionManager.on('summary', ({ sessionId, summary }) => {
    broadcast(wss, { type: 'summary', sessionId, summary });
  });

  // Periodic usage refresh (every 3 min)
  setInterval(async () => {
    const usage = await usageTracker.getUsage();
    broadcast(wss, { type: 'usage', usage, planLimits: PLAN_LIMITS });
  }, 180000);

  // Dev mode: watch files and trigger browser reload
  if (DEV_MODE) {
    const chokidar = require('chokidar');

    // Watch public dir for frontend changes
    const watcher = chokidar.watch([PUBLIC_DIR, LIB_DIR], {
      ignored: /node_modules/,
      ignoreInitial: true,
    });

    watcher.on('change', (changedPath) => {
      console.log(`[dev] File changed: ${changedPath}`);

      // If lib file changed, we'd need server restart (not handled here)
      // For now just reload browser for any change
      broadcast(wss, { type: 'reload' });
    });

    console.log('[dev] Hot reload enabled - watching for file changes');
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    sessionManager.killAll();
    process.exit(0);
  });

  server.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(`Claude Manager running at ${url}${DEV_MODE ? ' (dev mode)' : ''}`);
    // Dynamic import for ESM-only 'open' package
    const open = (await import('open')).default;
    open(url);
  });
}

function handleMessage(ws, msg, sessionManager, wss) {
  switch (msg.type) {
    case 'create':
      sessionManager.createSession();
      break;

    case 'switch':
      // Send full buffer for the session
      const buffer = sessionManager.getBuffer(msg.sessionId);
      ws.send(JSON.stringify({
        type: 'buffer',
        sessionId: msg.sessionId,
        data: buffer,
      }));
      break;

    case 'input':
      sessionManager.sendInput(msg.sessionId, msg.data);
      break;

    case 'archive':
      sessionManager.archiveSession(msg.sessionId);
      break;

    case 'unarchive':
      sessionManager.unarchiveSession(msg.sessionId);
      break;

    case 'rename':
      sessionManager.renameSession(msg.sessionId, msg.name);
      break;

    case 'resize':
      sessionManager.resizeSession(msg.sessionId, msg.cols, msg.rows);
      break;

    case 'delete':
      sessionManager.deleteSession(msg.sessionId);
      break;
  }
}

function broadcast(wss, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  });
}

main().catch(console.error);
