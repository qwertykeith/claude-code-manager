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
    this.hasDraftInput = false;

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
      /☐/,                         // Unchecked checkbox (question header)
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

    // Check for waiting patterns immediately in the buffer
    for (const pattern of this.waitingPatterns) {
      if (pattern.test(this.outputBuffer)) {
        this._updateStatus('waiting');
        return; // Don't override with 'working'
      }
    }

    // Substantial output means Claude is working, clear draft state
    if (this.outputBuffer.length > 20) {
      this.hasDraftInput = false;
      this._updateStatus('working');
    } else if (!this.pendingWorkingTimeout && this.status !== 'working') {
      // Set a short timeout - if more output comes, we'll show working
      this.pendingWorkingTimeout = setTimeout(() => {
        this.pendingWorkingTimeout = null;
        if (this.outputBuffer.length > 5) {
          this.hasDraftInput = false;
          this._updateStatus('working');
        }
      }, 150);
    }
  }

  onInput(data) {
    // If Enter is pressed, user submitted - clear draft and expect output
    if (data.includes('\r') || data.includes('\n')) {
      this.hasDraftInput = false;
      // Don't change status here - let output detection handle it
      return;
    }

    // Backspace/delete handling - if deleting, still in draft mode unless empty
    // We can't easily track exact input length, so just stay in draft if typing

    // If we're idle (at prompt), typing means draft
    if (this.status === 'idle' || this.status === 'draft') {
      this.hasDraftInput = true;
      this._updateStatus('draft');
    }
  }

  tick() {
    const now = Date.now();
    const timeSinceOutput = now - this.lastOutputTime;

    // If no output in 2 seconds, check patterns
    if (timeSinceOutput > 2000 && this.status === 'working') {
      // Check against both lastOutput and accumulated buffer
      const textToCheck = this.outputBuffer || this.lastOutput;
      console.log('[StatusDetector] tick check, status:', this.status, 'timeSince:', timeSinceOutput, 'bufferLen:', this.outputBuffer.length);
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
      if (this.hasDraftInput) {
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
    this.hasDraftInput = false;
  }
}

module.exports = { StatusDetector };
