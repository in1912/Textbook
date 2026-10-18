#!/bin/bash
# Textbook - macOS launcher. Double-click in Finder (or run ./start-macos.command).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5 or newer is required: https://nodejs.org/"
  read -r -p "Press Enter to close..."
  exit 1
fi

export PORT="${PORT:-9621}"
export TEXTBOOK_DATA_DIR="${TEXTBOOK_DATA_DIR:-$(pwd)/data}"

echo
echo "  Textbook  http://127.0.0.1:${PORT}/"
echo "  Data      ${TEXTBOOK_DATA_DIR}"
echo "  Stop      Ctrl+C"
echo
( sleep 2; open "http://127.0.0.1:${PORT}/" ) >/dev/null 2>&1 &
exec node --experimental-sqlite server/index.js
