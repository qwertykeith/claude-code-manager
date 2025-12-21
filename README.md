# Claude Manager

Local web app for running multiple Claude Code terminal sessions side-by-side.

## What it does

- Spawns Claude Code in real terminal sessions (via node-pty)
- Manage multiple sessions from one browser tab
- Archive/restore sessions
- Auto-summarizes your first prompt for each session
- Status detection (idle, working, waiting for input)

## Requirements

- Node.js 18+
- Claude Code CLI installed (`claude` command available)

## Usage

```bash
npm install
npm start
```

Opens automatically in your browser at `http://localhost:3001` (or next available port).

### Dev mode

```bash
npm run dev
```

Enables hot reload when you edit frontend files.

## Distribution

### Local install (for testing)

```bash
npm link
```

Now `claude-manager` command works globally on your machine.

### Publish to npm

```bash
npm login
npm publish
```

Users can then install via:

```bash
npm install -g claude-manager
claude-manager
```

Or run without installing:

```bash
npx claude-manager
```
