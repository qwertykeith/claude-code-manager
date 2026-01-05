const { spawn } = require('child_process');

/**
 * Summarizes long prompts using Claude with a cheap model
 */
class Summarizer {
  constructor() {
    this.MAX_LENGTH = 100;
  }

  /**
   * Get a summary for the given prompt
   * @param {string} prompt - The user's prompt
   * @returns {Promise<string>} - Summary (original if short, or AI-summarized)
   */
  async summarize(prompt) {
    // Clean up the prompt - strip ANSI escape codes FIRST, then control chars
    const cleaned = prompt
      .replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, '')       // CSI sequences (semicolon + colon for RGB)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (BEL or ST terminator)
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')     // DCS/SOS/PM/APC sequences
      .replace(/\x1b./g, '')                        // Any remaining escape + char
      .replace(/[\x00-\x1F\x7F]/g, '')              // Control characters
      .trim();

    if (cleaned.length <= this.MAX_LENGTH) {
      return cleaned;
    }

    // Use Claude to summarize
    try {
      const summary = await this._askClaude(cleaned);
      return summary || cleaned.slice(0, this.MAX_LENGTH) + '...';
    } catch (e) {
      // Summarization is best-effort, fall back to truncation
      return cleaned.slice(0, this.MAX_LENGTH) + '...';
    }
  }

  _askClaude(prompt) {
    return new Promise((resolve, reject) => {
      // Security: escape backslashes first, then quotes, then truncate
      const escapedPrompt = prompt
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .slice(0, 2000);
      const claudePrompt = `Summarize this task in under 10 words: "${escapedPrompt}"`;

      const proc = spawn('claude', ['--model', 'haiku', '--tools', '', '-p', claudePrompt], {
        timeout: 15000,
      });

      let output = '';
      let error = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        error += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          // Clean up the output - strip ANSI escape codes and quotes
          const stripped = output
            .replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, '')       // CSI sequences (semicolon + colon for RGB)
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (BEL or ST terminator)
            .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')     // DCS/SOS/PM/APC sequences
            .replace(/\x1b./g, '')                        // Any remaining escape + char
            .replace(/[\x00-\x1F\x7F]/g, '')              // Control characters
            .replace(/^\[[A-Z]+\]\s*/gi, '')              // Strip [INFO], [I] style prefixes
            .trim()
            .replace(/^["']|["']$/g, '');                 // Surrounding quotes
          resolve(stripped.slice(0, 100));
        } else {
          reject(new Error(error || 'Claude process failed'));
        }
      });

      proc.on('error', reject);

      // Kill after timeout
      setTimeout(() => {
        proc.kill();
        reject(new Error('Summarization timeout'));
      }, 15000);
    });
  }
}

module.exports = { Summarizer };
