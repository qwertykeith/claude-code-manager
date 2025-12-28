#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

// UUID v4 regex for session ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate WebSocket message fields
 * @returns {boolean} true if valid
 */
function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.type !== 'string') return false;

  // Validate sessionId if present
  if ('sessionId' in msg) {
    if (typeof msg.sessionId !== 'string' || !UUID_REGEX.test(msg.sessionId)) {
      return false;
    }
  }

  // Validate specific message types
  switch (msg.type) {
    case 'create':
    case 'open-vscode':
      return true;

    case 'switch':
    case 'archive':
    case 'unarchive':
    case 'delete':
      return 'sessionId' in msg;

    case 'input':
      return 'sessionId' in msg && typeof msg.data === 'string';

    case 'rename':
      return 'sessionId' in msg &&
        typeof msg.name === 'string' &&
        msg.name.length <= 200;

    case 'resize':
      return 'sessionId' in msg &&
        typeof msg.cols === 'number' && msg.cols > 0 && msg.cols <= 500 &&
        typeof msg.rows === 'number' && msg.rows > 0 && msg.rows <= 200;

    default:
      return false;
  }
}

async function main() {
  const port = await findAvailablePort(3001);
  const sessionManager = new SessionManager();
  const usageTracker = new UsageTracker();

  // Initialize sessions (start fresh)
  await sessionManager.loadSessions();

  // HTTP server for static files (no caching in dev mode)
  const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];

    // Security: resolve path and verify it stays within PUBLIC_DIR
    filePath = path.resolve(PUBLIC_DIR, '.' + filePath);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

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

    // Send usage data on connect - start with estimate, then send accurate
    const estimateUsage = await usageTracker.getUsage();
    ws.send(JSON.stringify({
      type: 'usage',
      usage: estimateUsage,
      planLimits: PLAN_LIMITS,
      source: 'jsonl-estimate',
    }));

    // Fetch accurate usage in background and send when ready
    usageTracker.getAccurateUsage().then((accurate) => {
      if (accurate && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'usage',
          accurate,
          planLimits: PLAN_LIMITS,
          source: 'claude-status',
        }));
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!validateMessage(msg)) {
          return; // Silently ignore invalid messages
        }
        handleMessage(ws, msg, sessionManager, wss);
      } catch (e) {
        // JSON parse error - ignore malformed messages
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

  // Periodic usage refresh (every 4 min - matches accurate cache TTL)
  setInterval(async () => {
    // Try accurate first, fall back to estimate
    const accurate = await usageTracker.getAccurateUsage();
    if (accurate) {
      broadcast(wss, {
        type: 'usage',
        accurate,
        planLimits: PLAN_LIMITS,
        source: 'claude-status',
      });
    } else {
      const usage = await usageTracker.getUsage();
      broadcast(wss, {
        type: 'usage',
        usage,
        planLimits: PLAN_LIMITS,
        source: 'jsonl-estimate',
      });
    }
  }, 240000);

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

  // Security: bind to localhost only - this tool should never be network-accessible
  server.listen(port, '127.0.0.1', async () => {
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

    case 'open-vscode': {
      // Security: use spawn with args array to avoid shell injection
      const cwd = process.cwd();
      const codeProc = spawn('code', [cwd], { stdio: 'ignore', detached: true });
      codeProc.unref();
      codeProc.on('error', (err) => console.error('Editor open failed:', err.message));

      // On macOS, activate the editor window after a short delay
      if (process.platform === 'darwin') {
        setTimeout(() => {
          const script = 'tell application "System Events" to set frontmost of first process whose name contains "Code" or name contains "Cursor" to true';
          const osa = spawn('osascript', ['-e', script], { stdio: 'ignore' });
          osa.on('error', () => {}); // Ignore activation errors
        }, 300);
      }
      break;
    }
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
