const pty = require('node-pty');

/**
 * Wrapper around node-pty for spawning Claude processes
 */
class PtyHandler {
  constructor(cwd, cols = 120, rows = 30) {
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    this.pty = null;
    this.buffer = '';
    this.onData = null;
    this.onExit = null;
  }

  spawn() {
    const shell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/zsh';
    const args = process.platform === 'win32' ? [] : ['-l'];

    try {
      this.pty = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: process.env,
      });
    } catch (err) {
      console.error('[PTY] Spawn failed:', err.message, 'cwd:', this.cwd, 'shell:', shell);
      throw err;
    }

    this.pty.onData((data) => {
      this.buffer += data;
      // Cap buffer at 1MB to prevent memory issues
      if (this.buffer.length > 1024 * 1024) {
        // Try to find a clean cut point (newline) to avoid splitting escape sequences
        let cutPoint = this.buffer.length - 512 * 1024;
        const newlineAfterCut = this.buffer.indexOf('\n', cutPoint);
        if (newlineAfterCut !== -1 && newlineAfterCut < cutPoint + 1000) {
          cutPoint = newlineAfterCut + 1;
        }
        this.buffer = this.buffer.slice(cutPoint);
        // Strip any orphaned partial escape sequence at the start
        // Match: digits, semicolons, colons not preceded by ESC[
        this.buffer = this.buffer.replace(/^[0-9;:]*[A-Za-z]/, '');
      }
      if (this.onData) this.onData(data);
    });

    this.pty.onExit(({ exitCode }) => {
      if (this.onExit) this.onExit(exitCode);
    });

    // Start claude immediately after shell starts
    // Small delay to let shell initialize
    setTimeout(() => {
      this.write('claude\r');
    }, 100);
  }

  write(data) {
    if (this.pty) {
      this.pty.write(data);
    }
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.pty) {
      this.pty.resize(cols, rows);
    }
  }

  kill() {
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
  }

  getBuffer() {
    // Prepend reset sequences to clear any partial escape state from truncation
    // \x1b[0m = reset all attributes
    // \x1b[?25h = show cursor
    // \x1b(B = select ASCII charset (fixes some shells)
    // \x1b[?7h = enable line wrap
    return '\x1b[0m\x1b(B\x1b[?25h\x1b[?7h' + this.buffer;
  }

  isRunning() {
    return this.pty !== null;
  }
}

module.exports = { PtyHandler };
