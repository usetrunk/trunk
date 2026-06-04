#!/bin/bash
# Loop wrapper for harness-poll.sh — runs in a zellij tab.
# Usage: harness-loop.sh <profile> <role> <runtime> [model] [interval]

PROFILE="${1:?}"
ROLE="${2:?}"
RUNTIME="${3:?}"
MODEL="${4:-qwen3:8b}"
INTERVAL="${5:-120}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

while true; do
  bash "$SCRIPT_DIR/harness-poll.sh" "$PROFILE" "$ROLE" "$RUNTIME" "$MODEL" 2>&1 || true
  echo ""
  echo "[loop] Sleeping ${INTERVAL}s... (Ctrl+C to stop)"
  sleep "$INTERVAL"
done
