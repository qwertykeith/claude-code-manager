# Claude Manager

Manage many sessions of Claude Code more easily and simply

I missed the agent workflow in cursor when I moved to CC exclusively so made this to replace it

## Features

- Manage multiple Claude Code sessions in one UI
- Real-time status indicators
- Track your usage against plan limits
- Prompt summarization
- One-click "Open IDE" to jump to your editor

## Install

```bash
git clone https://github.com/qwertykeith/claude-manager.git
cd claude-manager
npm install
npm link
```

Then run from any directory you want to work in:

```bash
claude-manager
```

## Upgrade

```bash
cd path/to/claude-manager
git pull
npm install
```

## Requirements

- Node.js 18+
- Claude Code CLI installed (`claude` command available)

## Development

```bash
npm install
npm run dev
```
