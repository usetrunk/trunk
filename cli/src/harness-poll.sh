#!/bin/bash
# Lightweight polling harness — no Goose, no MCP overhead for local models.
# Calls Trunk API directly, injects task context into ollama or claude.
#
# Usage: harness-poll.sh <profile> <role> <runtime> [model]
#   profile:  Trunk profile name (e.g., sk-delegate)
#   role:     Agent role for task routing (delegator|planner|builder|reviewer|merger|qa|docs)
#   runtime:  "ollama" or "claude"
#   model:    Ollama model name (default: qwen3:8b), ignored for claude

set -euo pipefail

PROFILE="${1:?Usage: harness-poll.sh <profile> <role> <runtime> [model]}"
ROLE="${2:?Missing role}"
RUNTIME="${3:?Missing runtime: ollama or claude}"
MODEL="${4:-qwen3:8b}"

CONFIG_DIR="$HOME/.trunk"
CONFIG_FILE="$CONFIG_DIR/config.${PROFILE}.json"
ROOM_ID="85256ec5-4095-4283-95f5-8cc70c458d3b"
RELAY_URL="${TRUNK_RELAY_URL:-https://trunk.bot}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[poll] No config for profile $PROFILE"
  exit 1
fi

SECRET=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['secret'])")
AGENT_ID=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['agent_id'])")

# Agent ID mappings for delegation
BUILDER_ID="08f8f3f4-4a21-4322-8a10-249e8eb9f050"
QA_ID="d1879ec0-06cc-4109-bfa3-231330449483"
DOCS_ID="6de0d0bc-154c-4fb9-8019-e41fd37b9d5c"
REVIEWER_ID="e8b64549-8ad4-4911-a79e-a1025dccd662"
MERGER_ID="5f8d4d18-3b5c-46bd-b0a9-c17c44fd119b"

# --- API helpers ---

trunk_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json")
  if [ -n "$body" ]; then
    args+=(-X "$method" -d "$body" -H "Idempotency-Key: $(uuidgen)")
  fi
  curl "${args[@]}" "${RELAY_URL}${path}" 2>/dev/null
}

get_tasks() {
  local status="${1:-open}" owner="${2:-}"
  local path="/tasks/room/${ROOM_ID}?status=${status}&limit=5"
  [ -n "$owner" ] && path="${path}&owner=${owner}"
  trunk_api GET "$path"
}

update_task() {
  local task_id="$1" body="$2"
  trunk_api PATCH "/tasks/${ROOM_ID}/${task_id}" "$body"
}

create_task() {
  local title="$1" group="$2" desc="${3:-}"
  trunk_api POST "/tasks" "{\"room_id\":\"${ROOM_ID}\",\"title\":\"$title\",\"group\":\"$group\",\"description\":\"$desc\",\"priority\":\"medium\"}"
}

# --- Run model ---

run_ollama() {
  local prompt="$1"
  ollama run "$MODEL" "$prompt" 2>/dev/null
}

run_claude() {
  local prompt="$1" cwd="$2"
  local mcp_config="$CONFIG_DIR/mcp-${PROFILE}.json"
  cd "$cwd"
  unset ANTHROPIC_API_KEY
  claude --dangerously-skip-permissions --mcp-config "$mcp_config" -p "$prompt"
}

# --- Role handlers ---

handle_delegator() {
  echo "[poll:$PROFILE] Checking for unassigned tasks..."
  local tasks_json
  tasks_json=$(get_tasks "open")

  local unassigned
  unassigned=$(echo "$tasks_json" | python3 -c "
import sys, json
tasks = json.load(sys.stdin).get('tasks', [])
unassigned = [t for t in tasks if not t.get('owner')][:3]
for t in unassigned:
    group = t.get('group', '') or 'other'
    print(f\"{t['id']}|{group}|{t['title']}\")
" 2>/dev/null)

  if [ -z "$unassigned" ]; then
    echo "[poll:$PROFILE] No unassigned tasks"
    return
  fi

  echo "$unassigned" | while IFS='|' read -r task_id group title; do
    local owner=""
    case "$group" in
      bugs|security) owner="$BUILDER_ID" ;;
      tests)         owner="$QA_ID" ;;
      docs)          owner="$DOCS_ID" ;;
      review)        owner="$REVIEWER_ID" ;;
      merge)         owner="$MERGER_ID" ;;
      *)             owner="$BUILDER_ID" ;;
    esac
    echo "[poll:$PROFILE] Assigning '$title' ($group) → ${owner:0:8}..."
    update_task "$task_id" "{\"owner\":\"$owner\"}" > /dev/null
  done

  # Check for open PRs that need review tasks
  local open_prs
  open_prs=$(gh pr list --repo SuperkeyHQ/superkey --state open --json number,title --limit 3 2>/dev/null || echo "[]")
  echo "$open_prs" | python3 -c "
import sys, json
prs = json.load(sys.stdin)
for pr in prs[:3]:
    print(f\"#{pr['number']} {pr['title']}\")
" 2>/dev/null | while read -r pr_line; do
    echo "[poll:$PROFILE] PR needs review: $pr_line"
  done
}

handle_planner() {
  echo "[poll:$PROFILE] Reviewing room state..."
  local tasks_json
  tasks_json=$(get_tasks)

  local summary
  summary=$(echo "$tasks_json" | python3 -c "
import sys, json
tasks = json.load(sys.stdin).get('tasks', [])
by_status = {}
for t in tasks:
    s = t.get('status', 'unknown')
    by_status[s] = by_status.get(s, 0) + 1
for s, c in sorted(by_status.items()):
    print(f'{s}: {c}')
print(f'total: {len(tasks)}')
" 2>/dev/null)

  echo "[poll:$PROFILE] Room state:"
  echo "$summary" | sed 's/^/  /'

  # Use ollama to assess if any planning is needed
  local prompt="You are a project planner. Here are the current task counts in the Superkey room:

$summary

Based on this, do any of the following need attention? Answer briefly (1-2 sentences each, or 'no action needed'):
1. Are there enough open tasks for the builder to work on?
2. Are there blocked tasks that need dependency resolution?
3. Should any large tasks be broken down?

Be concise."

  echo "[poll:$PROFILE] Asking model for assessment..."
  run_ollama "$prompt"
}

handle_builder() {
  echo "[poll:$PROFILE] Checking for assigned tasks..."
  local tasks_json
  tasks_json=$(get_tasks "open" "$AGENT_ID")

  local task_info
  task_info=$(echo "$tasks_json" | python3 -c "
import sys, json
tasks = json.load(sys.stdin).get('tasks', [])
if tasks:
    t = tasks[0]
    print(f\"{t['id']}|||{t['title']}|||{t.get('description','') or ''}|||{t.get('group','') or ''}\")
" 2>/dev/null)

  if [ -z "$task_info" ]; then
    echo "[poll:$PROFILE] No tasks assigned to me"
    return
  fi

  IFS='|||' read -r task_id _ title _ desc _ group _ <<< "$task_info"
  echo "[poll:$PROFILE] Working on: $title"

  # Mark in-progress
  update_task "$task_id" '{"status":"in-progress"}' > /dev/null

  local cwd="${BUILDER_CWD:-$HOME/dev/superkey/worktrees/sk-build}"
  local prompt="You have a task to complete in the Superkey codebase.

Task: $title
Description: $desc
Group: $group

Follow CLAUDE.md rules. Create a feature branch from main (git fetch origin main && git reset --hard origin/main && git checkout -b fix/<short-name>). Implement the fix with tests. Push and open a PR with gh pr create. When done, report what you did."

  run_claude "$prompt" "$cwd"

  # Mark done
  update_task "$task_id" '{"status":"done"}' > /dev/null
  echo "[poll:$PROFILE] Task completed"
}

handle_reviewer() {
  echo "[poll:$PROFILE] Checking for PRs to review..."

  # Get open PRs that haven't been reviewed yet
  local prs_json
  prs_json=$(gh pr list --repo SuperkeyHQ/superkey --state open --json number,title,author,reviewDecision,additions,deletions,changedFiles --limit 5 2>/dev/null || echo "[]")

  local unreviewd
  unreviewd=$(echo "$prs_json" | python3 -c "
import sys, json
prs = json.load(sys.stdin)
# Only review PRs that haven't been approved yet
for pr in prs:
    if pr.get('reviewDecision') != 'APPROVED':
        print(f\"{pr['number']}|{pr['title']}|+{pr.get('additions',0)}/-{pr.get('deletions',0)}|{pr.get('changedFiles',0)} files\")
" 2>/dev/null)

  if [ -z "$unreviewd" ]; then
    echo "[poll:$PROFILE] No PRs need review"
    return
  fi

  # Review the first unreviewed PR
  local pr_num pr_title pr_stats pr_files
  IFS='|' read -r pr_num pr_title pr_stats pr_files <<< "$(echo "$unreviewd" | head -1)"
  echo "[poll:$PROFILE] Reviewing PR #$pr_num: $pr_title ($pr_stats, $pr_files)"

  # Fetch the diff
  local diff
  diff=$(gh pr diff "$pr_num" --repo SuperkeyHQ/superkey 2>/dev/null | head -500)

  if [ -z "$diff" ]; then
    echo "[poll:$PROFILE] Could not fetch diff for #$pr_num"
    return
  fi

  # Ask the model to review
  local prompt="You are a code reviewer for a TypeScript/Hono/Drizzle application. Review this PR diff and give a brief assessment.

PR #$pr_num: $pr_title
Stats: $pr_stats, $pr_files

Diff (first 500 lines):
$diff

Assess:
1. Does the code look correct?
2. Any obvious bugs, security issues, or missing error handling?
3. Is the change well-scoped (not too broad)?
4. Verdict: APPROVE or REQUEST_CHANGES (with specific reason)

Be concise — 5 sentences max."

  local verdict
  verdict=$(run_ollama "$prompt" 2>/dev/null)
  echo "[poll:$PROFILE] Model verdict:"
  echo "$verdict" | sed 's/^/  /'

  # If the model says approve, approve it
  if echo "$verdict" | grep -qi "APPROVE" && ! echo "$verdict" | grep -qi "REQUEST_CHANGES"; then
    echo "[poll:$PROFILE] Approving PR #$pr_num"
    gh pr review "$pr_num" --repo SuperkeyHQ/superkey --approve --body "Automated review: code looks good. $pr_title" 2>&1 || echo "[poll:$PROFILE] Approve failed"
  else
    echo "[poll:$PROFILE] Not auto-approving — needs human or more detailed review"
    gh pr review "$pr_num" --repo SuperkeyHQ/superkey --comment --body "Automated review flagged concerns — please check:
$(echo "$verdict" | head -5)" 2>&1 || echo "[poll:$PROFILE] Comment failed"
  fi
}

handle_merger() {
  echo "[poll:$PROFILE] Checking for mergeable PRs..."
  local mergeable
  mergeable=$(gh pr list --repo SuperkeyHQ/superkey --state open --json number,title,reviewDecision,statusCheckRollup 2>/dev/null | python3 -c "
import sys, json
prs = json.load(sys.stdin)
for pr in prs:
    checks = pr.get('statusCheckRollup', [])
    all_pass = all(c.get('conclusion') == 'SUCCESS' or c.get('status') == 'COMPLETED' for c in checks) if checks else False
    approved = pr.get('reviewDecision') == 'APPROVED'
    if all_pass and approved:
        print(f\"{pr['number']}|{pr['title']}\")
" 2>/dev/null)

  if [ -z "$mergeable" ]; then
    echo "[poll:$PROFILE] No PRs ready to merge"
    return
  fi

  echo "$mergeable" | while IFS='|' read -r pr_num title; do
    echo "[poll:$PROFILE] Merging #$pr_num: $title"
    gh pr merge "$pr_num" --repo SuperkeyHQ/superkey --squash --auto 2>&1 || echo "[poll:$PROFILE] Merge failed for #$pr_num"
  done
}

handle_qa() {
  echo "[poll:$PROFILE] Running tests..."
  local cwd="${QA_CWD:-$HOME/dev/superkey/worktrees/sk-qa}"
  cd "$cwd"
  git fetch origin main && git reset --hard origin/main 2>/dev/null

  local test_result
  test_result=$(pnpm test 2>&1 | tail -5)
  echo "[poll:$PROFILE] Test result:"
  echo "$test_result" | sed 's/^/  /'

  if echo "$test_result" | grep -q "failed"; then
    echo "[poll:$PROFILE] Tests failed — creating bug task"
    local failures
    failures=$(echo "$test_result" | grep -i "fail" | head -3)
    create_task "Test failures: $(echo "$failures" | head -1 | cut -c1-80)" "bugs" "$(echo "$failures")" > /dev/null
  fi
}

handle_docs() {
  echo "[poll:$PROFILE] Checking for docs work..."
  local tasks_json
  tasks_json=$(get_tasks "open" "$AGENT_ID")

  local task_count
  task_count=$(echo "$tasks_json" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tasks',[])))" 2>/dev/null)

  if [ "$task_count" = "0" ]; then
    echo "[poll:$PROFILE] No docs tasks assigned"
    return
  fi

  local prompt="Check the Superkey user guide inventory. Read CLAUDE.md for the guide list. Compare against docs/user-guide/. Report which guides are missing. Create at most 2 missing guides following the template in CLAUDE.md."

  if [ "$RUNTIME" = "ollama" ]; then
    run_ollama "$prompt"
  else
    local cwd="${DOCS_CWD:-$HOME/dev/superkey/worktrees/sk-docs}"
    run_claude "$prompt" "$cwd"
  fi
}

# --- Main loop ---

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  [poll] $PROFILE ($ROLE) — $RUNTIME${RUNTIME:+/$MODEL}"
echo "  [poll] $(date)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

case "$ROLE" in
  delegator) handle_delegator ;;
  planner)   handle_planner ;;
  builder)   handle_builder ;;
  reviewer)  handle_reviewer ;;
  merger)    handle_merger ;;
  qa)        handle_qa ;;
  docs)      handle_docs ;;
  *) echo "[poll] Unknown role: $ROLE"; exit 1 ;;
esac
