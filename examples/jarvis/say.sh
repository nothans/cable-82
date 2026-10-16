#!/bin/sh
# Put Jarvis on CABLE 82: ./say.sh "Good evening."  or  ./say.sh --ask weather
STATION="${CABLE82:-http://cable82.local:1982}"
if [ "$1" = "--ask" ]; then
  BODY=$(printf '{"ask":"%s"}' "$2")
else
  # Escape backslashes and quotes so any line is valid JSON.
  LINE=$(printf '%s' "$*" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  BODY=$(printf '{"text":"%s"}' "$LINE")
fi
curl -sS -X POST "$STATION/api/jarvis" -H 'content-type: application/json' -d "$BODY"
echo
