const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const path = require('path');
const { PtyHandler } = require('./pty-handler');
const { StatusDetector } = require('./status-detector');
const { Summarizer } = require('./summarizer');

/**
 * Manages all Claude Code sessions
 */
class SessionManager extends EventEmitter {
  constructor(persistence) {
    super();
    this.sessions = new Map();
    this.persistence = persistence;
    this.summarizer = new Summarizer();
    this.cwd = process.cwd();

    // Status tick interval
    this._tickInterval = setInterval(() => this._tick(), 1000);
  }

  async loadSessions() {
    const saved = this.persistence.load();
    for (const s of saved) {
      // Restore session without PTY (idle state)
      this.sessions.set(s.id, {
        ...s,
        status: 'idle',
        pty: null,
        statusDetector: new StatusDetector(),
        firstInputCaptured: !!s.summary,
      });
    }
    this.emit('update');
  }

  createSession() {
    const id = randomUUID();
    const name = path.basename(this.cwd);

    const session = {
      id,
      name,
      cwd: this.cwd,
      status: 'idle',
      summary: '',
      originalPrompt: '',
      archived: false,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      pty: null,
      statusDetector: new StatusDetector(),
      firstInputCaptured: false,
    };

    this.sessions.set(id, session);
    this._spawnPty(session);
    this._save();
    this.emit('update');
    return session;
  }

  _spawnPty(session) {
    const pty = new PtyHandler(session.cwd);

    pty.onData = (data) => {
      session.lastActivity = new Date().toISOString();
      session.statusDetector.onOutput(data);
      this.emit('output', { sessionId: session.id, data });
    };

    pty.onExit = () => {
      session.pty = null;
      session.status = 'idle';
      this.emit('status', { sessionId: session.id, status: 'idle' });
      this.emit('update');
    };

    session.statusDetector.onStatusChange = (status) => {
      session.status = status;
      this.emit('status', { sessionId: session.id, status });
      this._save();
    };

    pty.spawn();
    session.pty = pty;
    session.status = 'working';
  }

  sendInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Spawn PTY if not running (e.g., after restore)
    if (!session.pty) {
      this._spawnPty(session);
    }

    // Accumulate input until Enter is pressed for first prompt capture
    if (!session.firstInputCaptured) {
      session.inputBuffer = (session.inputBuffer || '') + data;
      console.log('[DEBUG sendInput] accumulating:', JSON.stringify(data), 'buffer now:', JSON.stringify(session.inputBuffer));

      // Check if Enter was pressed (\r or \n)
      if (data.includes('\r') || data.includes('\n')) {
        const fullPrompt = session.inputBuffer;
        session.firstInputCaptured = true;
        session.inputBuffer = '';
        console.log('[DEBUG sendInput] Enter pressed, full prompt:', JSON.stringify(fullPrompt));
        this._captureFirstInput(session, fullPrompt);
      }
    }

    // Track input for draft status detection
    session.statusDetector.onInput(data);

    session.pty.write(data);
    session.lastActivity = new Date().toISOString();
    this._save();
  }

  async _captureFirstInput(session, input) {
    console.log('[DEBUG] _captureFirstInput called with:', JSON.stringify(input));
    // Clean up input - strip ANSI escape codes first, then control chars
    const cleaned = input
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI escape codes
      .replace(/\x1b\][^\x07]*\x07/g, '')      // OSC sequences
      .replace(/[\x00-\x1F\x7F]/g, '')         // Control characters
      .trim();
    console.log('[DEBUG] cleaned input:', JSON.stringify(cleaned));
    if (!cleaned) {
      console.log('[DEBUG] cleaned is empty, returning early');
      return;
    }

    session.originalPrompt = cleaned;
    console.log('[DEBUG] calling summarizer.summarize');
    const summary = await this.summarizer.summarize(cleaned);
    console.log('[DEBUG] got summary:', JSON.stringify(summary));
    session.summary = summary;
    this._save();
    this.emit('summary', { sessionId: session.id, summary, originalPrompt: cleaned });
    this.emit('update');
  }

  archiveSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.pty) {
      session.pty.kill();
      session.pty = null;
    }

    session.archived = true;
    session.status = 'idle';
    this._save();
    this.emit('update');
  }

  unarchiveSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.archived = false;
    // Don't spawn PTY - user can type to restart
    this._save();
    this.emit('update');
  }

  renameSession(sessionId, name) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.name = name;
    this._save();
    this.emit('update');
  }

  resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (session?.pty) {
      session.pty.resize(cols, rows);
    }
  }

  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.pty) {
      session.pty.kill();
    }

    this.sessions.delete(sessionId);
    this._save();
    this.emit('update');
  }

  getBuffer(sessionId) {
    const session = this.sessions.get(sessionId);
    return session?.pty?.getBuffer() || '';
  }

  getAllSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      summary: s.summary,
      originalPrompt: s.originalPrompt,
      archived: s.archived,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
    }));
  }

  killAll() {
    for (const session of this.sessions.values()) {
      if (session.pty) {
        session.pty.kill();
      }
    }
    clearInterval(this._tickInterval);
  }

  _tick() {
    for (const session of this.sessions.values()) {
      if (session.statusDetector) {
        session.statusDetector.tick();
      }
    }
  }

  _save() {
    this.persistence.save(this.getAllSessions());
  }
}

module.exports = { SessionManager };
