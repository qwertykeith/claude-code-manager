const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CONTEXT_LIMIT = 200000; // Opus 4.5 context window

/**
 * Track context window usage per session by reading Claude's JSONL conversation files
 */
class ContextTracker {
  constructor() {
    this.cache = new Map(); // cwd -> { tokens, pct, display, timestamp }
    this.cacheTTL = 10000; // 10 seconds
  }

  /**
   * Convert cwd to Claude's escaped project folder path
   * /Users/keith/code/foo -> -Users-keith-code-foo
   */
  escapeCwd(cwd) {
    return cwd.replace(/\//g, '-');
  }

  /**
   * Get the most recently modified JSONL file for a project
   */
  getActiveConversationFile(cwd) {
    const escapedPath = this.escapeCwd(cwd);
    const projectDir = path.join(CLAUDE_DIR, escapedPath);

    if (!fs.existsSync(projectDir)) {
      return null;
    }

    try {
      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = path.join(projectDir, f);
          return {
            path: fullPath,
            mtime: fs.statSync(fullPath).mtimeMs
          };
        })
        .sort((a, b) => b.mtime - a.mtime);

      return files.length > 0 ? files[0].path : null;
    } catch {
      return null;
    }
  }

  /**
   * Get context usage for a session's cwd
   * Returns { tokens, pct, display } or null
   */
  async getContextForCwd(cwd) {
    if (!cwd) return null;

    // Check cache
    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return { tokens: cached.tokens, pct: cached.pct, display: cached.display };
    }

    const filePath = this.getActiveConversationFile(cwd);
    if (!filePath) return null;

    const usage = await this._getLastUsage(filePath);
    if (!usage) return null;

    // Cache result
    this.cache.set(cwd, { ...usage, timestamp: Date.now() });
    return { tokens: usage.tokens, pct: usage.pct, display: usage.display };
  }

  /**
   * Read last assistant message with usage data from JSONL file
   * Returns { tokens, pct, display } or null
   */
  async _getLastUsage(filePath) {
    return new Promise((resolve) => {
      let lastUsage = null;

      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        try {
          const entry = JSON.parse(line);
          const msg = entry.message;

          // Only assistant messages with complete usage data
          if (!msg || msg.role !== 'assistant' || !msg.usage) return;
          if (!msg.stop_reason) return;

          const usage = msg.usage;
          const tokens = (usage.input_tokens || 0) +
                        (usage.cache_read_input_tokens || 0) +
                        (usage.cache_creation_input_tokens || 0);

          lastUsage = tokens;
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        if (lastUsage === null) {
          resolve(null);
          return;
        }

        const pct = Math.round((lastUsage / CONTEXT_LIMIT) * 100);
        const display = `${pct}%`;

        resolve({ tokens: lastUsage, pct, display });
      });

      rl.on('error', () => resolve(null));
    });
  }

  /**
   * Clear cache for a specific cwd (call when session gets output)
   */
  invalidate(cwd) {
    this.cache.delete(cwd);
  }
}

module.exports = { ContextTracker, CONTEXT_LIMIT };
