const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CONTEXT_LIMIT = 200000; // Opus 4.5 context window
const THRESHOLDS = [0, 20, 40, 60, 80, 95]; // Trigger accurate check at these %

/**
 * Track context window usage per session
 * Uses JSONL estimate as heuristic, fetches accurate /context data at thresholds
 */
class ContextTracker {
  constructor() {
    this.cache = new Map(); // cwd -> { tokens, pct, display, timestamp, accurate, lastThreshold }
    this.pending = new Map(); // cwd -> Promise - dedupe concurrent accurate fetches
    this.cacheTTL = 10000; // 10 seconds for estimates
    this.accurateCacheTTL = 60000; // 1 min for accurate data
  }

  /**
   * Convert cwd to Claude's escaped project folder path
   * /Users/keith/code/foo -> -Users-keith-code-foo
   */
  escapeCwd(cwd) {
    return cwd.replace(/\//g, '-');
  }

  /**
   * Get the most recently modified JSONL file for a project (async to avoid blocking)
   */
  async getActiveConversationFile(cwd) {
    const escapedPath = this.escapeCwd(cwd);
    const projectDir = path.join(CLAUDE_DIR, escapedPath);

    try {
      await fsp.access(projectDir);
    } catch {
      return null;
    }

    try {
      const filenames = await fsp.readdir(projectDir);
      const jsonlFiles = filenames.filter(f => f.endsWith('.jsonl'));

      // Get stats in parallel for all files
      const filesWithStats = await Promise.all(
        jsonlFiles.map(async (f) => {
          const fullPath = path.join(projectDir, f);
          try {
            const stat = await fsp.stat(fullPath);
            return { path: fullPath, mtime: stat.mtimeMs };
          } catch {
            return null;
          }
        })
      );

      const validFiles = filesWithStats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
      return validFiles.length > 0 ? validFiles[0].path : null;
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

    const cached = this.cache.get(cwd);
    const now = Date.now();

    // Return accurate cached data if fresh
    if (cached?.accurate && now - cached.timestamp < this.accurateCacheTTL) {
      return { tokens: cached.tokens, pct: cached.pct, display: cached.display };
    }

    // Get JSONL estimate
    const filePath = await this.getActiveConversationFile(cwd);
    let estimate = null;

    if (filePath) {
      estimate = await this._getEstimateFromJsonl(filePath);
    }

    // No estimate available (new session) - try accurate fetch directly
    if (!estimate) {
      const accurate = await this._getAccurateContext(cwd);
      if (accurate) {
        this.cache.set(cwd, {
          ...accurate,
          timestamp: now,
          accurate: true,
          lastThreshold: this._getThresholdBucket(accurate.pct),
        });
        return { tokens: accurate.tokens, pct: accurate.pct, display: accurate.display };
      }
      return null;
    }

    // Check if we crossed a threshold - triggers accurate fetch
    const lastThreshold = cached?.lastThreshold ?? -1;
    const currentThreshold = this._getThresholdBucket(estimate.pct);

    if (currentThreshold !== lastThreshold) {
      // Crossed threshold, fetch accurate data
      const accurate = await this._getAccurateContext(cwd);
      if (accurate) {
        this.cache.set(cwd, {
          ...accurate,
          timestamp: now,
          accurate: true,
          lastThreshold: currentThreshold,
        });
        return { tokens: accurate.tokens, pct: accurate.pct, display: accurate.display };
      }
    }

    // Use estimate (or stale accurate data if available)
    const result = cached?.accurate ? cached : estimate;
    this.cache.set(cwd, {
      ...result,
      timestamp: now,
      accurate: false,
      lastThreshold: cached?.lastThreshold ?? currentThreshold,
    });
    return { tokens: result.tokens, pct: result.pct, display: result.display };
  }

  /**
   * Determine which threshold bucket a percentage falls into
   */
  _getThresholdBucket(pct) {
    for (let i = THRESHOLDS.length - 1; i >= 0; i--) {
      if (pct >= THRESHOLDS[i]) return THRESHOLDS[i];
    }
    return 0;
  }

  /**
   * Run /context in a temp Claude session and parse output
   * Deduplicates concurrent calls for the same cwd
   */
  async _getAccurateContext(cwd) {
    // Dedupe: if already fetching for this cwd, return pending promise
    if (this.pending.has(cwd)) {
      return this.pending.get(cwd);
    }

    const promise = this._doAccurateContextFetch(cwd);
    this.pending.set(cwd, promise);

    try {
      return await promise;
    } finally {
      this.pending.delete(cwd);
    }
  }

  /**
   * Actually spawn the claude process (internal - use _getAccurateContext)
   */
  async _doAccurateContextFetch(cwd) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, 10000); // 10s timeout

      const proc = spawn('claude', ['-p', '/context'], {
        cwd,
        env: { ...process.env, NO_COLOR: '1' },
      });

      let output = '';
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.stderr.on('data', (data) => { output += data.toString(); });

      proc.on('close', () => {
        clearTimeout(timeout);
        // Parse: "65k/200k tokens (32%)" or "65000/200000 tokens (32%)"
        const match = output.match(/(\d+)(k?)\/(\d+)(k?)\s*tokens\s*\((\d+)%\)/i);
        if (match) {
          const used = parseInt(match[1]) * (match[2] ? 1000 : 1);
          const pct = parseInt(match[5]);
          resolve({ tokens: used, pct, display: `${pct}%` });
        } else {
          resolve(null);
        }
      });

      proc.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });
  }

  /**
   * Estimate context from JSONL usage data (heuristic, not 100% accurate)
   * Misses autocompact buffer but good enough for threshold detection
   */
  async _getEstimateFromJsonl(filePath) {
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
          // Include output_tokens since they're part of context for next turn
          const tokens = (usage.input_tokens || 0) +
                        (usage.output_tokens || 0) +
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
        resolve({ tokens: lastUsage, pct, display: `~${pct}%` }); // ~ indicates estimate
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
