const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Handles persisting session state to disk
 */
class Persistence {
  constructor() {
    this.configDir = this._getConfigDir();
    this.filePath = path.join(this.configDir, 'sessions.json');
    this._saveTimeout = null;
  }

  _getConfigDir() {
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || os.homedir(), 'claude-manager');
    }
    return path.join(os.homedir(), '.config', 'claude-manager');
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
    return [];
  }

  save(sessions) {
    // Debounce saves
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }
    this._saveTimeout = setTimeout(() => {
      this._doSave(sessions);
    }, 500);
  }

  _doSave(sessions) {
    try {
      this._ensureDir();
      // Strip non-serializable fields
      const toSave = sessions.map((s) => ({
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        summary: s.summary,
        archived: s.archived,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
      }));
      fs.writeFileSync(this.filePath, JSON.stringify(toSave, null, 2));
    } catch (e) {
      console.error('Failed to save sessions:', e);
    }
  }
}

module.exports = { Persistence };
