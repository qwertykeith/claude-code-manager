const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

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
    this.cacheTTL = 30000; // 30 seconds
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
      fiveHour: { messages: 0 },
      monthly: { messages: 0 },
    };

    if (!fs.existsSync(CLAUDE_DIR)) {
      return totals;
    }

    const projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(CLAUDE_DIR, d.name));

    for (const projectDir of projectDirs) {
      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(projectDir, f));

      for (const file of files) {
        await this._parseFile(file, fiveHoursAgo, monthStartMs, totals);
      }
    }

    return totals;
  }

  async _parseFile(filePath, fiveHoursAgo, monthStartMs, totals) {
    return new Promise((resolve) => {
      const stat = fs.statSync(filePath);
      // Skip files older than a month (optimization)
      if (stat.mtimeMs < monthStartMs) {
        resolve();
        return;
      }

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
