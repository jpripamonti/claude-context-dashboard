#!/bin/bash
# Opens the dashboard for a given project folder, starting the server if it
# isn't already running (reuses one that is, so double-clicking the desktop
# launcher repeatedly doesn't fail with "port already in use").
#
# Usage: open-dashboard.sh /path/to/project

PROJECT_PATH="$1"
PORT=4317
DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "$PROJECT_PATH" ]; then
  echo "usage: open-dashboard.sh /path/to/project" >&2
  exit 1
fi

fail() {
  # Launched from the desktop app there is no terminal to print to, so say it
  # in a dialog as well as on stderr.
  osascript -e "display alert \"Claude context dashboard\" message \"$1\"" >/dev/null 2>&1
  echo "$1" >&2
  exit 1
}

# A double-clicked .app gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
# which does not include Node installed via nvm or Homebrew — so find it.
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  local newest
  newest=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
  [ -n "$newest" ] && [ -x "$newest" ] && { echo "$newest"; return 0; }
  return 1
}

NODE=$(find_node) || fail "Could not find Node.js on this machine. Install it, or run the dashboard from a terminal instead."

is_up() { curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/projects" 2>/dev/null; }

if ! is_up; then
  nohup "$NODE" "$DASHBOARD_DIR/bin/cli.js" --path "$PROJECT_PATH" --port "$PORT" --no-open \
    > /tmp/claude-context-dashboard.log 2>&1 &

  for _ in $(seq 1 20); do
    is_up && break
    sleep 0.25
  done

  is_up || fail "The dashboard server did not start. See /tmp/claude-context-dashboard.log for details."
fi

ENCODED_PATH=$("$NODE" -e "console.log(encodeURIComponent(process.argv[1]))" "$PROJECT_PATH")
open "http://localhost:$PORT/?path=$ENCODED_PATH"
