#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const prebuildsDir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

if (!fs.existsSync(prebuildsDir)) {
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
