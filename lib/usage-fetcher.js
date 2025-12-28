const { spawn } = require('child_process');

// Python script to capture /status via PTY
const PYTHON_SCRIPT = `
import pty
import os
import select
import time
import sys
import json
import re

def fetch_usage():
    master, slave = pty.openpty()
    pid = os.fork()

    if pid == 0:
        os.close(master)
        os.setsid()
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        os.close(slave)
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLUMNS'] = '120'
        os.environ['LINES'] = '40'
        os.execvp('claude', ['claude'])
    else:
        os.close(slave)
        output = b''

        def read_output(timeout=1):
            data = b''
            end_time = time.time() + timeout
            while time.time() < end_time:
                r, _, _ = select.select([master], [], [], 0.1)
                if r:
                    try:
                        chunk = os.read(master, 8192)
                        if chunk:
                            data += chunk
                    except:
                        break
            return data

        try:
            # Wait for initial prompt
            output += read_output(3)

            # Type /status, then Down arrow to select from autocomplete, then Enter
            os.write(master, b'/status')
            time.sleep(0.5)
            os.write(master, b'\\x1b[B')  # Down arrow to select from autocomplete
            time.sleep(0.2)
            os.write(master, b'\\r')
            time.sleep(1.5)
            output += read_output(2)

            # Tab to Usage tab - one at a time with pauses
            os.write(master, b'\\t')  # Status -> Config
            time.sleep(0.5)
            output += read_output(0.5)
            os.write(master, b'\\t')  # Config -> Usage
            time.sleep(0.5)
            output += read_output(1.5)

        finally:
            os.kill(pid, 9)
            os.close(master)

        # Parse output
        text = output.decode('utf-8', errors='replace')

        # Extract data
        result = {
            'session': {'percent': None, 'resetTime': None},
            'weekAll': {'percent': None, 'resetTime': None},
            'weekSonnet': {'percent': None},
            'source': 'claude-status'
        }

        # Find all "X% used" patterns
        pct_matches = list(re.finditer(r'(\\d+)%\\s*used', text))

        # Find reset times
        session_reset = re.search(r'Current session.*?Resets?\\s+([^\\n\\[]+)', text, re.DOTALL)
        week_reset = re.search(r'Current week \\(all models\\).*?Resets?\\s+([^\\n\\[]+)', text, re.DOTALL)

        if len(pct_matches) >= 1:
            result['session']['percent'] = int(pct_matches[0].group(1))
        if len(pct_matches) >= 2:
            result['weekAll']['percent'] = int(pct_matches[1].group(1))
        if len(pct_matches) >= 3:
            result['weekSonnet']['percent'] = int(pct_matches[2].group(1))

        if session_reset:
            # Clean up ANSI codes and extract time
            reset_text = re.sub(r'\\x1b\\[[0-9;]*m', '', session_reset.group(1)).strip()
            # Extract just the time part (e.g., "11pm" from "11pm (Australia/Melbourne)")
            time_match = re.match(r'([\\d:]+[ap]m)', reset_text)
            if time_match:
                result['session']['resetTime'] = time_match.group(1)
            else:
                result['session']['resetTime'] = reset_text.split('(')[0].strip()

        if week_reset:
            reset_text = re.sub(r'\\x1b\\[[0-9;]*m', '', week_reset.group(1)).strip()
            # Extract date and time (e.g., "Jan 3, 11am")
            date_match = re.match(r'([A-Za-z]+ \\d+,?\\s*\\d*,?\\s*[\\d:]+[ap]m)', reset_text)
            if date_match:
                result['weekAll']['resetTime'] = date_match.group(1).replace('  ', ' ')
            else:
                result['weekAll']['resetTime'] = reset_text.split('(')[0].strip()

        print(json.dumps(result))

if __name__ == '__main__':
    fetch_usage()
`;

/**
 * Fetch accurate usage data from Claude Code's /status command
 * Returns structured data or null on failure
 */
async function fetchClaudeUsage() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 15000); // 15 second timeout

    const proc = spawn('python3', ['-c', PYTHON_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0 || !stdout.trim()) {
        console.error('[usage-fetcher] Failed:', stderr || 'No output');
        resolve(null);
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (e) {
        console.error('[usage-fetcher] Parse error:', e.message);
        resolve(null);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[usage-fetcher] Spawn error:', err.message);
      resolve(null);
    });
  });
}

module.exports = { fetchClaudeUsage };
