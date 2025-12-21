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
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const args = process.platform === 'win32' ? [] : ['-l'];

    this.pty = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: process.env,
    });

    this.pty.onData((data) => {
      this.buffer += data;
      // Cap buffer at 1MB to prevent memory issues
      if (this.buffer.length > 1024 * 1024) {
        this.buffer = this.buffer.slice(-512 * 1024);
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
    return this.buffer;
  }

  isRunning() {
    return this.pty !== null;
  }
}

module.exports = { PtyHandler };
