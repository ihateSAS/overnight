#!/usr/bin/env bash
# Record N takes, spaced so each starts with a fresh per-minute token budget.
# usage: tools/takes.sh <prefix> <count> [gap-seconds]
cd "$(dirname "$0")/.."
for i in $(seq 1 "$2"); do
  node tools/record.mjs "$1-$i" 2>&1 | tail -1
  [ "$i" -lt "$2" ] && sleep "${3:-100}"
done
