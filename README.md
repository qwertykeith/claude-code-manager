# Claude Manager

Manage multiple sessions of Claude Code more easily

I missed the agent workflow in cursor when I moved to CC exclusively so made this to replace it

## Install

```bash
npm install -g github:qwertykeith/claude-manager
```

Then run from any directory you want to work in:

```bash
claude-manager
```

> **Note:** npx doesn't work reliably due to native module issues with node-pty.

## Requirements

- Node.js 18+
- Claude Code CLI installed (`claude` command available)

## Development

```bash
npm install
npm run dev
```
