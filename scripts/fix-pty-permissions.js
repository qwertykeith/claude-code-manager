#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// npm may hoist node-pty to different locations depending on install context
const possiblePaths = [
  // Local development: ./node_modules/node-pty/prebuilds
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds'),
  // Hoisted install: ../../../node-pty/prebuilds (from @qwertykeith/claude-code-manager/scripts/)
  path.join(__dirname, '..', '..', '..', 'node-pty', 'prebuilds'),
  // npx/global: ../../node-pty/prebuilds
  path.join(__dirname, '..', '..', 'node-pty', 'prebuilds'),
];

const prebuildsDir = possiblePaths.find(p => fs.existsSync(p));

if (!prebuildsDir) {
  process.exit(0);
}

for (const platform of fs.readdirSync(prebuildsDir)) {
  const helperPath = path.join(prebuildsDir, platform, 'spawn-helper');
  if (fs.existsSync(helperPath)) {
    try {
      fs.chmodSync(helperPath, 0o755);
    } catch (e) {
      // Ignore permission errors on Windows
    }
  }
}
