#!/bin/bash
set -euo pipefail

# SessionStart hook for Claude Code on the web.
# Installs Node dependencies so the project is ready to run in remote sessions.
# Runs only in the remote environment; local sessions are left untouched.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install dependencies. `npm install` (not `npm ci`) lets the cached container
# layer be reused across sessions and is idempotent.
npm install
