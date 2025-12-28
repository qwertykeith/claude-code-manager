const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const readline = require('readline');
const { fetchClaudeUsage } = require('./usage-fetcher');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

// Plan limits (messages per 5 hours)
const PLAN_LIMITS = {
  pro: 45,
  max100: 225,
  max200: 900,
};

/**
 * Parse usage data from Claude's local JSONL files
 * Counts completed assistant messages (not tokens)
 */
class UsageTracker {
  constructor() {
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTTL = 30000; // 30 seconds for JSONL fallback

    // Accurate usage from /status (4 minute cache)
    this.accurateCache = null;
    this.accurateCacheTime = 0;
    this.accurateCacheTTL = 240000; // 4 minutes
    this.fetchInProgress = false;
  }

  /**
   * Get accurate usage from Claude /status command
   * Returns cached data or fetches fresh data
   */
  async getAccurateUsage() {
    const now = Date.now();

    // Return cache if fresh
    if (this.accurateCache && (now - this.accurateCacheTime) < this.accurateCacheTTL) {
      return this.accurateCache;
    }

    // Don't start another fetch if one is in progress
    if (this.fetchInProgress) {
      return this.accurateCache; // Return stale cache or null
    }

    // Fetch fresh data
    this.fetchInProgress = true;
    try {
      const data = await fetchClaudeUsage();
      if (data && data.session && data.session.percent !== null) {
        this.accurateCache = data;
        this.accurateCacheTime = now;
      }
      return this.accurateCache;
    } catch (err) {
      console.error('[usage-tracker] Fetch error:', err.message);
      return this.accurateCache; // Return stale cache on error
    } finally {
      this.fetchInProgress = false;
    }
  }

  async getUsage() {
    const now = Date.now();
    if (this.cache && (now - this.cacheTime) < this.cacheTTL) {
      return this.cache;
    }

    const usage = await this._calculateUsage();
    this.cache = usage;
    this.cacheTime = now;
    return usage;
  }

  async _calculateUsage() {
    const fiveHoursAgo = Date.now() - (5 * 60 * 60 * 1000);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartMs = monthStart.getTime();

    const totals = {
      fiveHour: { messages: 0, newestTimestamp: null },
      monthly: { messages: 0 },
    };

    try {
      await fsp.access(CLAUDE_DIR);
    } catch {
      return totals;
    }

    const entries = await fsp.readdir(CLAUDE_DIR, { withFileTypes: true });
    const projectDirs = entries
      .filter(d => d.isDirectory())
      .map(d => path.join(CLAUDE_DIR, d.name));

    for (const projectDir of projectDirs) {
      try {
        const filenames = await fsp.readdir(projectDir);
        const files = filenames
          .filter(f => f.endsWith('.jsonl'))
          .map(f => path.join(projectDir, f));

        for (const file of files) {
          await this._parseFile(file, fiveHoursAgo, monthStartMs, totals);
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    return totals;
  }

  async _parseFile(filePath, fiveHoursAgo, monthStartMs, totals) {
    // Check file age first (skip old files to save time)
    try {
      const stat = await fsp.stat(filePath);
      if (stat.mtimeMs < monthStartMs) {
        return;
      }
    } catch {
      return;
    }

    return new Promise((resolve) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        try {
          const entry = JSON.parse(line);

          // Count completed assistant messages with usage data
          // A "message" is a complete response (has stop_reason)
          const msg = entry.message;
          if (!msg || msg.role !== 'assistant' || !msg.usage) return;
          if (!msg.stop_reason) return; // Only count completed messages
          if (!entry.timestamp) return;

          const ts = new Date(entry.timestamp).getTime();
          if (isNaN(ts)) return;

          if (ts >= monthStartMs) {
            totals.monthly.messages++;
          }

          if (ts >= fiveHoursAgo) {
            totals.fiveHour.messages++;
            if (!totals.fiveHour.newestTimestamp || ts > totals.fiveHour.newestTimestamp) {
              totals.fiveHour.newestTimestamp = ts;
            }
          }
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', resolve);
      rl.on('error', resolve);
    });
  }
}

module.exports = { UsageTracker, PLAN_LIMITS };
