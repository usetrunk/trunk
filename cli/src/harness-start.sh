#!/bin/bash
# Start all agents in a zellij session with the lightweight polling harness.
# Each agent gets a tab running harness-loop.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION="trunk-harness"
ZELLIJ="${ZELLIJ_BIN:-/opt/homebrew/bin/zellij}"

# Kill any existing session
$ZELLIJ kill-session "$SESSION" 2>/dev/null || true
$ZELLIJ delete-session "$SESSION" 2>/dev/null || true

# Agent definitions: profile|role|runtime|model|interval
AGENTS=(
  "sk-delegate|delegator|ollama|qwen3:8b|60"
  "sk-plan|planner|ollama|qwen3:8b|180"
  "sk-build|builder|claude|unused|120"
  "sk-review|reviewer|ollama|qwen3:8b|120"
  "sk-merge|merger|ollama|qwen3:8b|90"
  "sk-qa|qa|ollama|qwen3:8b|300"
  "sk-docs|docs|ollama|qwen3:8b|300"
)

# Build KDL layout
LAYOUT="layout {"
for agent_def in "${AGENTS[@]}"; do
  IFS='|' read -r profile role runtime model interval <<< "$agent_def"
  LAYOUT+="
    tab name=\"$profile\" {
        pane command=\"bash\" {
            args \"$SCRIPT_DIR/harness-loop.sh\" \"$profile\" \"$role\" \"$runtime\" \"$model\" \"$interval\"
        }
    }"
done
LAYOUT+="
}"

LAYOUT_FILE="$HOME/.trunk/harness-layout.kdl"
echo "$LAYOUT" > "$LAYOUT_FILE"

# Start zellij
$ZELLIJ -s "$SESSION" -n "$LAYOUT_FILE" &
disown

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Harness started: ${#AGENTS[@]} agents in zellij"
echo ""
echo "  Agents:"
for agent_def in "${AGENTS[@]}"; do
  IFS='|' read -r profile role runtime model interval <<< "$agent_def"
  printf "    %-14s %-10s %-8s %s\n" "$profile" "$role" "$runtime" "${interval}s"
done
echo ""
echo "  Attach:   zellij attach $SESSION"
echo "  Stop:     zellij kill-session $SESSION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
