#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install root dependencies (express, colors — for server.js)
npm install

# Install continuum dependencies (vite — used by test runner)
npm install --prefix continuum

# Start the app server in the background
# Kills any existing instance first so restarts are safe
pkill -f "node server.js" 2>/dev/null || true
nohup node server.js >> /tmp/yoga-server.log 2>&1 &
echo "App server started on port 1024 (PID $!)"
