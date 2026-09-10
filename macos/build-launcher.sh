#!/bin/bash
# Builds the double-clickable desktop launcher from Launcher.applescript,
# baking in this project's current location. Run it again if the project moves.
#
# Usage: build-launcher.sh [destination .app path]

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$DIR/.." && pwd)"
APP_NAME="Claude Context Dashboard.app"
DEST="${1:-$HOME/Desktop/$APP_NAME}"

TMP_SCRIPT="$(mktemp -t claude-context-launcher).applescript"
trap 'rm -f "$TMP_SCRIPT"' EXIT

sed "s|__DASHBOARD_DIR__|$PROJECT_DIR|" "$DIR/Launcher.applescript" > "$TMP_SCRIPT"

rm -rf "$DEST"
osacompile -o "$DEST" "$TMP_SCRIPT"
echo "Built: $DEST"
echo "  points at: $PROJECT_DIR"
