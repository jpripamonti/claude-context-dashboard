#!/bin/bash
# Opens the dashboard for a given project folder, starting the server if it
# isn't already running (reuses one that is, so double-clicking the desktop
# launcher repeatedly doesn't fail with "port already in use").
#
# Every API request needs the key the server made when it started. Started
# from here there is no terminal to print it to, so the server leaves it in
# ~/.claude-context-dashboard/run/<port>.token (only you can read it), and this
# script reads it from there — for a server it started or one already running.
#
# Usage: open-dashboard.sh /path/to/project
# (CLAUDE_DASHBOARD_PORT overrides the port; the test suite uses it.)

PROJECT_PATH="$1"
PORT="${CLAUDE_DASHBOARD_PORT:-4317}"
DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$HOME/.claude-context-dashboard/run"
TOKEN_FILE="$RUN_DIR/$PORT.token"
# The server prints its address, key included, so its output stays in a folder
# only you can open rather than in /tmp.
LOG="$RUN_DIR/server-$PORT.log"

fail() {
  # Launched from the desktop app there is no terminal to print to, so say it
  # in a dialog as well as on stderr. The text goes in as an argument, so
  # quotes in it cannot break the script.
  osascript -e 'on run argv' -e 'display alert "Claude context dashboard" message (item 1 of argv)' -e 'end run' "$1" >/dev/null 2>&1
  echo "$1" >&2
  exit 1
}

if [ -z "$PROJECT_PATH" ]; then
  echo "usage: open-dashboard.sh /path/to/project" >&2
  exit 1
fi

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

mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR" || fail "Could not create $RUN_DIR."

# The key in the token file, or nothing if there is none or it is not shaped
# like one (so nothing else from that file reaches curl's config or the page).
read_token() {
  local t=""
  [ -r "$TOKEN_FILE" ] && t=$(<"$TOKEN_FILE")
  [[ "$t" =~ ^[A-Za-z0-9_-]{43}$ ]] && printf '%s' "$t"
}

# HTTP status of /api/projects asked with that key: 200 is a dashboard that
# takes it, 403 one that does not, 000 nothing listening at all. The header is
# handed to curl on stdin (printf is a shell builtin), never on its command
# line, where every user on the machine could read it with `ps`.
probe() {
  local code
  code=$(printf 'header = "X-Dashboard-Token: %s"\n' "$(read_token)" |
    curl -s -o /dev/null -w '%{http_code}' --max-time 1 -K - "http://127.0.0.1:$PORT/api/projects" 2>/dev/null)
  echo "${code:-000}"
}

CODE=$(probe)
TRIES=4
if [ "$CODE" = 000 ]; then
  # the log is created private first, in a subshell, so the server itself still
  # runs under your usual umask (it creates files in your projects)
  ( umask 077; rm -f "$LOG"; : > "$LOG" ) || fail "Could not create $LOG."
  nohup "$NODE" "$DASHBOARD_DIR/bin/cli.js" --path "$PROJECT_PATH" --port "$PORT" --no-open \
    > "$LOG" 2>&1 &
  SERVER_PID=$!
  TRIES=40
fi

# A server that has just started writes its key a moment after it starts
# listening, so a refusal is worth asking again for a little while — unless
# the one started here has already given up (the port is taken, say).
for _ in $(seq 1 "$TRIES"); do
  [ "$CODE" = 200 ] && break
  [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null && break
  sleep 0.25
  CODE=$(probe)
done

case "$CODE" in
  200) ;;
  000) fail "The dashboard server did not start. See $LOG for details." ;;
  403) fail "A dashboard is already running on port $PORT, but it did not accept the key in $TOKEN_FILE (it may be an older version, or have been started some other way). Stop it - Ctrl+C in its terminal, or: pkill -f $DASHBOARD_DIR/bin/cli.js - and try again." ;;
  *) fail "Something other than the dashboard is answering on port $PORT (HTTP $CODE)." ;;
esac

TOKEN=$(read_token)
ENCODED_PATH=$("$NODE" -e "console.log(encodeURIComponent(process.argv[1]))" "$PROJECT_PATH")
URL="http://localhost:$PORT/?path=$ENCODED_PATH#token=$TOKEN"

# The browser is not handed the address itself, for the same reason as above:
# `open`'s command line, and the browser's if this launches it, is visible to
# every user. It is handed a page only you can read, which sends the tab on to
# the real address (bin/cli.js does the same), and that page is removed again
# once a browser that has to start first has had time to read it. Both parts
# of the address are safe inside a JS string: the key is base64url and the
# path went through encodeURIComponent.
if TRAMPOLINE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/claude-context-XXXXXX" 2>/dev/null) &&
  ( umask 077; printf '<!doctype html><meta charset="utf-8"><title>claude-context-dashboard</title><script>location.replace("%s")</script>' "$URL" > "$TRAMPOLINE_DIR/open.html" ); then
  open "$TRAMPOLINE_DIR/open.html"
  ( sleep 120; rm -rf "$TRAMPOLINE_DIR" ) >/dev/null 2>&1 &
else
  open "$URL"
fi
