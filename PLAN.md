# Claude Code Terminal Manager — Build Plan

## Overview

A local web app for managing multiple Claude Code terminal sessions. Shows status (working / waiting for input / idle), displays a summary of each session's task, and lets you switch between them. Sessions can be archived (process stopped, hidden) and restored.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js |
| Language | JavaScript (TypeScript only if it stays simple) |
| PTY | node-pty |
| WebSocket | ws |
| Terminal rendering | xterm.js (via CDN) |
| Frontend | Plain HTML + vanilla JS |
| Persistence | JSON file in OS config directory |
| File watching | chokidar (for dev mode hot reload) |
| Distribution | npm package, optionally compiled to single binary via pkg or bun |

---

## Project Structure

```
claude-code-manager/
├── package.json
├── server.js              # Main entry point
├── lib/
│   ├── session-manager.js # Create, list, archive, restore sessions
│   ├── pty-handler.js     # Spawn and manage PTY processes
│   ├── status-detector.js # Determine working/waiting/idle
│   ├── summarizer.js      # Get summary from initial prompt
│   ├── persistence.js     # Save/load session state to disk
│   └── port-finder.js     # Find available port
├── public/
│   ├── index.html         # Single page app
│   ├── app.js             # Frontend logic
│   └── style.css          # Minimal styling
└── README.md
```

---

## Data Model

```javascript
// Session object
{
  id: "uuid",
  name: "my-project",           // Editable, defaults to directory name
  cwd: "/path/to/project",      // Always the directory server was started in
  status: "idle",               // "working" | "waiting" | "idle"
  summary: "Refactor auth...",  // First prompt, or summarized if >100 chars
  archived: false,
  createdAt: "2025-01-15T...",
  lastActivity: "2025-01-15T..."
}
```

---

## Core Behaviors

### Starting the App

1. Server starts
2. Find available port (start at 3001, increment until free)
3. Load persisted sessions from config file
4. Persisted sessions load as "idle" with no running process (user can reconnect or archive)
5. Auto-open browser to `localhost:{port}`

### Creating a Session

1. User clicks "New Session" button
2. Backend spawns `claude` process via node-pty in the server's cwd
3. Session created with status "idle", no summary yet
4. Frontend connects to that session's terminal stream

### Capturing Summary

1. Detect first user input sent to the PTY
2. If ≤100 characters: store as-is
3. If >100 characters: spawn a separate short-lived `claude` process with a cheap model:

   ```
   claude --model haiku "Summarize this task in under 10 words: {user's prompt}"
   ```

4. Capture output, store as summary, kill summarizer process

Note: Using `--model haiku` (or equivalent flag) keeps summarization fast and cheap. Check Claude CLI docs for exact flag syntax.

### Status Detection

Run on every output event and on a 1-second interval:

| Status | Detection |
|--------|-----------|
| **Working** | Output received within last 2 seconds |
| **Waiting for input** | Output stopped AND last output matches patterns: ends with `?`, contains `(y/n)`, contains `[Y/n]`, or other confirmation patterns |
| **Idle** | Output stopped AND at main prompt (detect `>` or `$` at end of buffer with no pending question) |

Status sent to frontend via WebSocket whenever it changes.

### Switching Sessions

1. User clicks session in sidebar
2. Frontend sends `{ type: "switch", sessionId: "..." }`
3. Backend confirms; frontend clears terminal, attaches to new session's stream
4. Full buffer for that session replayed to xterm.js so user sees history

### Archiving

1. User clicks archive button on a session
2. Backend kills the PTY process if running
3. Session marked `archived: true`
4. Session moves to "Archived" section in sidebar
5. State persisted to disk

### Unarchiving

1. User clicks restore on an archived session
2. Session marked `archived: false`
3. Moves back to main list
4. Status is "idle" — process is not restarted automatically
5. User can send new input to restart work, which spawns a fresh PTY

### Persistence

Config file location:

- macOS: `~/.config/claude-code-manager/sessions.json`
- Linux: `~/.config/claude-code-manager/sessions.json`
- Windows: `%APPDATA%\claude-code-manager\sessions.json`

Saved on every state change (debounced). Contains array of session objects without the live PTY reference.

On app restart, sessions reload but no processes are running. Non-archived sessions appear as "idle" and can be typed into (which spawns a new PTY). Archived sessions stay archived.

---

## WebSocket Protocol

### Server → Client

```javascript
{ type: "sessions", sessions: [...] }              // Full session list
{ type: "status", sessionId: "...", status: "working" }
{ type: "summary", sessionId: "...", summary: "..." }
{ type: "output", sessionId: "...", data: "..." }  // Terminal output bytes
{ type: "buffer", sessionId: "...", data: "..." }  // Full terminal buffer on switch
{ type: "reload" }                                 // Hot reload trigger (dev mode only)
```

### Client → Server

```javascript
{ type: "create" }                                 // New session
{ type: "switch", sessionId: "..." }               // Switch view
{ type: "input", sessionId: "...", data: "..." }   // Keyboard input
{ type: "archive", sessionId: "..." }
{ type: "unarchive", sessionId: "..." }
{ type: "rename", sessionId: "...", name: "..." }
{ type: "resize", sessionId: "...", cols: 80, rows: 24 }
{ type: "delete", sessionId: "..." }               // Permanently delete session
```

---

## Frontend UI Layout

```
┌──────────────────────────────────────────────────────────┐
│  Claude Manager                          [+ New Session] │
├────────────────┬─────────────────────────────────────────┤
│                │                                         │
│  SESSIONS      │                                         │
│                │                                         │
│  ● Add auth  × │      (xterm.js terminal view)           │
│                │                                         │
│  ◐ ? Fix CSS × │                                         │
│                │                                         │
│  ○ New tests × │                                         │
│                │                                         │
├────────────────┤                                         │
│  ARCHIVED      │                                         │
│                │                                         │
│  ○ old task    │  [Restore] [Delete]                     │
│                │                                         │
└────────────────┴─────────────────────────────────────────┘
```

Status indicators:

- `●` green dot (pulsing) = working
- `◐` yellow dot (pulsing) + `?` badge = waiting for input
- `○` gray dot = idle

Session card shows summary text directly (no separate name/summary). Archive `×` appears on hover. Double-click to rename.

---

## Build Steps

### Phase 1: Minimal Server

1. Create package.json with dependencies: `ws`, `node-pty`, `open` (for auto-opening browser)
2. Implement port-finder.js — scan from 3001 until a port is free
3. Basic server.js — start HTTP server, serve static files from `public/`
4. Auto-open browser on startup using `open` package

### Phase 2: PTY Management

1. Implement pty-handler.js — spawn `claude` in a PTY, expose write/onData/kill
2. Implement session-manager.js — create sessions, store in memory, get by ID
3. Wire up WebSocket in server.js — handle create/switch/input messages
4. Forward PTY output to client, forward client input to PTY

### Phase 3: Frontend Terminal

1. Create index.html — basic layout with sidebar and terminal container
2. Load xterm.js and xterm-addon-fit from CDN
3. Implement app.js — connect WebSocket, render session list, attach xterm to output stream
4. Handle switching: clear terminal, replay buffer, update active highlight

### Phase 4: Status Detection

1. Implement status-detector.js — track last output time, pattern match for waiting
2. Run detection on output events and 1-second interval
3. Broadcast status changes via WebSocket
4. Frontend updates indicators on status messages

### Phase 5: Summarization

1. Implement summarizer.js — detect first input, capture it
2. If >100 chars, spawn `claude --model haiku` with summarization prompt
3. Parse output, store summary, kill process
4. Broadcast summary to frontend

### Phase 6: Archive/Unarchive

1. Add archive/unarchive handlers in session-manager
2. Archive: kill PTY, mark archived
3. Unarchive: mark not archived, leave PTY null (spawns on next input)
4. Frontend: separate archived list, restore button

### Phase 7: Persistence

1. Implement persistence.js — determine config path per OS, read/write JSON
2. Load sessions on startup
3. Save on every mutation (debounce 500ms)
4. Strip non-serializable fields (PTY instance) before saving

### Phase 8: Polish

1. Editable session names (click to edit)
2. Handle terminal resize (xterm-addon-fit + resize message to PTY)
3. Graceful shutdown — kill all PTYs on SIGINT
4. Error handling — PTY spawn failures, WebSocket disconnects

---

## Changelog

### v0.2 Fixes

**Summary Display Fix**
- Fixed ANSI escape codes appearing in summaries (was showing `[i` instead of summary)
- Added stripping of ANSI codes, OSC sequences, and control characters in `summarizer.js`

**Session Card Redesign**
- Removed redundant folder name display (since all sessions are in the same cwd)
- Shows summary as main text, falls back to name if no summary
- Archive button moved inline, only shows on hover, uses subtle `×` icon

**Status Detection Improvements**
- Fixed status flashing on focus/typing by requiring substantial output (>20 chars) before showing "working"
- Added 150ms debounce for small output bursts
- Status no longer flickers when user focuses terminal or types

**Waiting State Indicator**
- Added `?` badge next to sessions waiting for user input
- Added pulsing animation to waiting status dot
- Makes it clear which sessions need attention

---

## Testing Checklist

- [ ] Start app, browser opens automatically
- [ ] Create new session, see Claude Code prompt
- [ ] Type a short prompt, summary appears immediately
- [ ] Type a long prompt (>100 chars), summary appears after a moment
- [ ] Status shows "working" while Claude outputs
- [ ] Status shows "waiting" when Claude asks a question
- [ ] Status shows "idle" at main prompt
- [ ] Switch between sessions, terminal shows correct content
- [ ] Archive a session, it moves to archived list, process stops
- [ ] Unarchive a session, it moves back, can type to restart
- [ ] Restart the app, sessions still listed
- [ ] Rename a session

---

## Distribution

### Option 1: npm publish (for public distribution)

Publish to npm registry:

```bash
npm publish
```

Recipients install globally:

```bash
npm install -g claude-code-manager
claude-code-manager
```

Or run directly without installing:

```bash
npx claude-code-manager
```

### Option 2: npm pack (shareable tarball)

Create a tarball for sharing directly:

```bash
npm pack
# Creates: claude-code-manager-1.0.0.tgz
```

Send the `.tgz` file. Recipient installs with:

```bash
npm install -g ./claude-code-manager-1.0.0.tgz
claude-code-manager
```

### Option 3: Single binary with pkg (no Node.js required)

Build standalone executables for all platforms:

```bash
# Install pkg
npm install -g pkg

# Build for all platforms
npx pkg . --targets node18-macos-arm64,node18-macos-x64,node18-linux-x64,node18-win-x64 --out-path dist

# Or just current platform
npx pkg . --output claude-code-manager
```

Produces executables that run without Node.js installed.

**Note:** node-pty requires native compilation, so binaries are platform-specific.

### Option 4: Single binary with Bun

If you have Bun installed:

```bash
bun build ./server.js --compile --outfile claude-code-manager
```

Produces a single executable for your current platform.

### Option 5: Zip for manual distribution

For quick sharing where recipient has Node.js:

```bash
zip -r claude-code-manager.zip . -x "node_modules/*" -x ".git/*" -x "*.tgz"
```

Recipient extracts and runs:

```bash
unzip claude-code-manager.zip -d claude-code-manager
cd claude-code-manager
npm install
npm start
```

### Distribution summary

| Method | Recipient needs | Best for |
|--------|-----------------|----------|
| npm publish | Node.js + npm | Public distribution |
| npm pack | Node.js + npm | Private sharing to devs |
| pkg binary | Nothing | Non-technical users |
| bun binary | Nothing | Single-platform, fast build |
| Zip | Node.js + npm | Quick sharing, full source |

---

## Development

### Running in dev mode

```bash
npm run dev
```

Dev mode enables:
- **Hot reload**: When files in `public/` or `lib/` change, connected browsers automatically reload
- **No caching**: Static files served with `Cache-Control: no-store`
- **Console logging**: File change events logged to terminal

The server watches for file changes using chokidar and broadcasts a `{ type: "reload" }` message to all connected WebSocket clients, which triggers `location.reload()`.

Note: Changes to `lib/` files require a server restart to take effect (the browser will reload but the server code won't hot-swap).
