/**
 * Detects the status of a Claude Code session based on terminal output
 * Status can be: "working" | "waiting" | "idle" | "draft"
 */
class StatusDetector {
  constructor() {
    this.lastOutputTime = 0;
    this.lastOutput = '';
    this.status = 'idle';
    this.onStatusChange = null;
    this.outputBuffer = '';
    this.outputBurstStart = 0;
    this.pendingWorkingTimeout = null;
    this.draftLength = 0; // Track actual draft text length (not just "has input")
    this.terminalBuffer = ''; // Persistent buffer for idle detection (doesn't reset like outputBuffer)

    // Patterns for "waiting for input" detection
    this.waitingPatterns = [
      /\?\s*$/,                    // Ends with ?
      /\(y\/n\)/i,                 // (y/n) or (Y/N)
      /\[y\/n\]/i,                 // [y/n] or [Y/N]
      /\[yes\/no\]/i,              // [yes/no]
      /press enter/i,              // Press enter to continue
      /continue\?/i,               // Continue?
      /proceed\?/i,                // Proceed?
      /confirm/i,                  // Confirm
      /\(yes\/no\)/i,              // (yes/no)
      /Enter to select.*Esc to cancel/i,  // Claude Code AskUserQuestion UI
    ];

    // Patterns for "idle" detection (at Claude prompt)
    this.idlePatterns = [
      />\s*$/,                     // Claude prompt ends with >
      /\$\s*$/,                    // Shell prompt ends with $
      /claude>\s*$/i,              // Explicit claude prompt
    ];
  }

  onOutput(data) {
    const now = Date.now();
    this.lastOutputTime = now;
    this.lastOutput = data;

    // Accumulate output to detect bursts vs single chars
    // Reset buffer if > 500ms since last output (new burst)
    if (now - this.outputBurstStart > 500) {
      this.outputBuffer = '';
      this.outputBurstStart = now;
    }
    this.outputBuffer += data;

    // Append to persistent terminal buffer (capped at 2000 chars for idle detection)
    this.terminalBuffer += data;
    if (this.terminalBuffer.length > 2000) {
      this.terminalBuffer = this.terminalBuffer.slice(-2000);
    }

    // Check for waiting patterns immediately in the buffer
    for (const pattern of this.waitingPatterns) {
      if (pattern.test(this.outputBuffer)) {
        this._updateStatus('waiting');
        return; // Don't override with 'working'
      }
    }

    // Substantial output means Claude is working (but not if user is typing - that's just echo)
    if (this.outputBuffer.length > 20 && this.draftLength === 0) {
      this._updateStatus('working');
    } else if (!this.pendingWorkingTimeout && this.status !== 'working' && this.draftLength === 0) {
      // Set a short timeout - if more output comes, we'll show working
      this.pendingWorkingTimeout = setTimeout(() => {
        this.pendingWorkingTimeout = null;
        if (this.outputBuffer.length > 5 && this.draftLength === 0) {
          this._updateStatus('working');
        }
      }, 150);
    }
  }

  onInput(data) {
    const hexView = [...data].map(c => {
      const code = c.charCodeAt(0);
      return code < 32 || code > 126 ? `\\x${code.toString(16).padStart(2, '0')}` : c;
    }).join('');
    console.log('[STATUS INPUT]', JSON.stringify(data), 'hex:', hexView, 'draftLen before:', this.draftLength);

    // If Enter is pressed, user submitted - clear draft and transition to working
    if (data.includes('\r') || data.includes('\n')) {
      this.draftLength = 0;
      console.log('[STATUS INPUT] Enter pressed, reset draftLength to 0');
      // Transition from draft to working - we're expecting a response
      if (this.status === 'draft') {
        this._updateStatus('working');
      }
      return;
    }

    // Filter out ANSI escape sequence responses (terminal query responses like cursor position)
    // These come as input but aren't actual user typing
    // Pattern: ESC [ ... (params) ... final_byte
    const cleanedData = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    if (cleanedData.length === 0) {
      console.log('[STATUS INPUT] filtered out escape sequences, no user input');
      return; // All input was escape sequences, not user typing
    }

    // Track actual draft length accounting for backspace/delete
    for (const char of cleanedData) {
      const code = char.charCodeAt(0);
      if (code === 127 || code === 8) {
        // Backspace or DEL - decrease length
        this.draftLength = Math.max(0, this.draftLength - 1);
      } else if (code >= 32 || code === 9) {
        // Printable char or tab - increase length
        this.draftLength++;
      }
      // Ignore other control chars
    }

    console.log('[STATUS INPUT] draftLen after:', this.draftLength);

    // Only show draft if there's actual text
    if (this.draftLength > 0 && this.status !== 'working') {
      this._updateStatus('draft');
    } else if (this.draftLength === 0 && this.status === 'draft') {
      this._updateStatus('idle');
    }
  }

  tick() {
    const now = Date.now();
    const timeSinceOutput = now - this.lastOutputTime;

    // If no output in 2 seconds, check patterns
    if (timeSinceOutput > 2000 && this.status === 'working') {
      // Use persistent terminalBuffer for idle detection (doesn't reset like outputBuffer)
      const textToCheck = this.terminalBuffer;
      console.log('[StatusDetector] tick check, status:', this.status, 'timeSince:', timeSinceOutput, 'bufferLen:', this.terminalBuffer.length);
      console.log('[StatusDetector] buffer sample:', JSON.stringify(textToCheck.slice(-200)));

      // Check if waiting for input
      for (const pattern of this.waitingPatterns) {
        if (pattern.test(textToCheck)) {
          console.log('[StatusDetector] matched waiting pattern:', pattern);
          this._updateStatus('waiting');
          return;
        }
      }

      // Check if at idle prompt
      for (const pattern of this.idlePatterns) {
        if (pattern.test(textToCheck)) {
          this._updateStatus('idle');
          return;
        }
      }

      // Default to idle if output stopped but no clear pattern
      // But if we have draft input, stay in draft
      if (this.draftLength > 0) {
        this._updateStatus('draft');
      } else {
        this._updateStatus('idle');
      }
    }
  }

  _updateStatus(newStatus) {
    if (newStatus !== this.status) {
      this.status = newStatus;
      if (this.onStatusChange) {
        this.onStatusChange(newStatus);
      }
    }
  }

  getStatus() {
    return this.status;
  }

  reset() {
    this.lastOutputTime = 0;
    this.lastOutput = '';
    this.status = 'idle';
    this.draftLength = 0;
    this.terminalBuffer = '';
  }
}

module.exports = { StatusDetector };
