# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm install      # Install dependencies (runs postinstall script for node-pty permissions)
npm start        # Production mode
npm run dev      # Dev mode with hot reload (watches public/ and lib/ dirs)
```

No test suite currently exists.

## Architecture

Web-based multi-session manager for Claude Code CLI. Node.js server spawns PTY processes running `claude` and exposes them via WebSocket to a browser UI using xterm.js.

### Key Components

- `server.js` - HTTP server (port 41917+), WebSocket handler, dev mode hot reload
- `lib/session-manager.js` - Session lifecycle, EventEmitter broadcasting to clients
- `lib/pty-handler.js` - node-pty wrapper, spawns shell then runs `claude` command
- `lib/status-detector.js` - Determines working/waiting/idle from terminal output patterns
- `lib/summarizer.js` - Extracts summary from first user prompt (uses haiku model for long prompts)
- `lib/usage-tracker.js` - Parses Claude's JSONL files + `/status` command for usage %
- `lib/context-tracker.js` - Tracks context per session cwd
- `public/` - Vanilla JS frontend, xterm.js via CDN

### Data Flow

1. Client connects via WebSocket
2. Creates session -> SessionManager spawns PTY -> PTY runs `claude`
3. PTY output streamed to client via WebSocket `output` messages
4. StatusDetector analyzes output patterns, broadcasts `status` changes
5. First user input captured for summary generation

### WebSocket Protocol

Server -> Client: `sessions`, `status`, `summary`, `output`, `buffer`, `usage`, `context`, `reload`
Client -> Server: `create`, `switch`, `input`, `archive`, `unarchive`, `rename`, `resize`, `delete`, `open-vscode`

### Session Status States

- `working` - Output received within last 2 seconds
- `waiting` - Output stopped AND last output matches question patterns (?, y/n)
- `idle` - At prompt with no pending question

## Important Notes

- Server binds to localhost only (127.0.0.1) for security
- Sessions are ephemeral (not persisted across restarts) despite persistence.js existing in PLAN.md
- PTY buffer capped at 1MB to prevent memory issues
- Dev mode: lib/ changes need server restart, public/ changes auto-reload browser
