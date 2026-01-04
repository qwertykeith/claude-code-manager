#!/bin/bash
set -e

# Generate commit message from diff using claude (cheap haiku call)
generate_msg() {
  local diff=$(git diff --cached --stat)
  if [ -z "$diff" ]; then
    echo "bump"
  else
    claude --model haiku -p "Write a conventional commit message (feat:/fix:/docs:/chore:) under 50 chars for this diff. Output ONLY the message, nothing else: $diff" 2>/dev/null | head -1 || echo "update"
  fi
}

# Check for changes
if [ -n "$(git status --porcelain)" ]; then
  git add .

  # Use provided message or generate one
  if [ -n "$1" ]; then
    MSG="$1"
  else
    MSG=$(generate_msg)
  fi

  git commit -m "$MSG"
fi

# Push to github
git push origin main

# Bump patch version
npm version patch --no-git-tag-version
git add package.json
git commit -m "bump"
git push origin main

# Publish to npm
npm publish --access public

# Verify the published package works
echo "verifying npm package..."
sleep 2  # npm registry propagation
npx --yes @qwertykeith/claude-code-manager &
sleep 3
pkill -f "node.*claude-code-manager" 2>/dev/null || true

echo "shipped!"
