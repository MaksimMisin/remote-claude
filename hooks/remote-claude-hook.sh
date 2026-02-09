#!/usr/bin/env bash
# ============================================================
# Remote Claude Hook Script
# Called by Claude Code on every hook event via stdin JSON.
# Transforms events into ClaudeEvent format, appends to JSONL,
# and POSTs to the Remote Claude server.
# ============================================================

set -o pipefail

# --- Pause guard (touch ~/.remote-claude/paused to skip all processing) ---
[ -f "$HOME/.remote-claude/paused" ] && exit 0

# --- Configuration ---
DATA_DIR="$HOME/.remote-claude/data"
EVENTS_FILE="$DATA_DIR/events.jsonl"
SERVER_URL="http://localhost:4080/event"
HOOK_SECRET_FILE="$DATA_DIR/hook-secret.txt"
HOOK_SECRET=""
if [ -f "$HOOK_SECRET_FILE" ]; then
  HOOK_SECRET="$(cat "$HOOK_SECRET_FILE" 2>/dev/null)" || true
fi

# --- Ensure data directory exists ---
mkdir -p "$DATA_DIR" 2>/dev/null

# --- Check for jq ---
JQ="$(command -v jq 2>/dev/null)"
if [ -z "$JQ" ]; then
  echo "remote-claude-hook: WARNING: jq not found, hook events will not be recorded" >&2
  exit 0
fi

# --- Read stdin (may be empty for some events) ---
INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat 2>/dev/null)" || true
fi

# Default to empty object if stdin was empty or missing
if [ -z "$INPUT" ]; then
  INPUT="{}"
fi

# Validate that input is valid JSON
if ! echo "$INPUT" | "$JQ" empty 2>/dev/null; then
  echo "remote-claude-hook: WARNING: invalid JSON on stdin, using empty object" >&2
  INPUT="{}"
fi

# --- Extract event type, session ID, and CWD from JSON input ---
RAW_EVENT="$(echo "$INPUT" | "$JQ" -r '.hook_event_name // "unknown"')"

case "$RAW_EVENT" in
  PreToolUse)        EVENT_TYPE="pre_tool_use" ;;
  PostToolUse)       EVENT_TYPE="post_tool_use" ;;
  Stop)              EVENT_TYPE="stop" ;;
  UserPromptSubmit)  EVENT_TYPE="user_prompt_submit" ;;
  SessionStart)      EVENT_TYPE="session_start" ;;
  SessionEnd)        EVENT_TYPE="session_end" ;;
  Notification)      EVENT_TYPE="notification" ;;
  *)                 EVENT_TYPE="$RAW_EVENT" ;;
esac

SESSION_ID="$(echo "$INPUT" | "$JQ" -r '.session_id // "unknown"')"
CWD="$(echo "$INPUT" | "$JQ" -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd 2>/dev/null || echo unknown)"

# --- Detect git branch and dirty state ---
GIT_BRANCH=""
GIT_DIRTY="false"
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  GIT_BRANCH="$(cd "$CWD" && git rev-parse --abbrev-ref HEAD 2>/dev/null)" || true
  if [ -n "$GIT_BRANCH" ]; then
    if [ -n "$(cd "$CWD" && git status --porcelain 2>/dev/null | head -1)" ]; then
      GIT_DIRTY="true"
    fi
  fi
fi

# --- Detect tmux target (session:window.pane) ---
TMUX_BIN="/opt/homebrew/bin/tmux"
[ ! -x "$TMUX_BIN" ] && TMUX_BIN="/usr/local/bin/tmux"
[ ! -x "$TMUX_BIN" ] && TMUX_BIN="$(command -v tmux 2>/dev/null || true)"
TMUX_TARGET=""
if [ -n "$TMUX_BIN" ] && [ -x "$TMUX_BIN" ] && [ -n "${TMUX_PANE:-}" ]; then
  TMUX_TARGET="$("$TMUX_BIN" display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || true)"
fi

# --- Generate timestamp (milliseconds) and unique ID ---
# macOS date doesn't support %N, so use perl for ms precision
TIMESTAMP_MS="$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time()*1000' 2>/dev/null || date +%s000)"
RANDOM_HEX="$(head -c 4 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null | head -c 4)" || true
[ -z "$RANDOM_HEX" ] && RANDOM_HEX="0000"
EVENT_ID="${SESSION_ID}-${TIMESTAMP_MS}-${RANDOM_HEX}"

# --- Extract fields from input based on event type ---
TOOL=""
TOOL_INPUT="{}"
TOOL_USE_ID=""
ASSISTANT_TEXT=""
MARKER_JSON="null"
SUCCESS="null"
ERROR=""
TOTAL_TOKENS="null"

case "$EVENT_TYPE" in
  pre_tool_use)
    TOOL="$(echo "$INPUT" | "$JQ" -r '.tool_name // ""')"
    TOOL_INPUT="$(echo "$INPUT" | "$JQ" -c '.tool_input // {}')"
    TRANSCRIPT_PATH="$(echo "$INPUT" | "$JQ" -r '.transcript_path // ""')"

    # For ExitPlanMode, read the most recently modified plan file
    if [ "$TOOL" = "ExitPlanMode" ]; then
      PLANS_DIR="$HOME/.claude/plans"
      if [ -d "$PLANS_DIR" ]; then
        PLAN_FILE="$(ls -t "$PLANS_DIR"/*.md 2>/dev/null | head -1)"
        if [ -n "$PLAN_FILE" ] && [ -f "$PLAN_FILE" ]; then
          TOOL_INPUT="$(echo "$TOOL_INPUT" | "$JQ" -c --rawfile pc "$PLAN_FILE" --arg pf "$PLAN_FILE" '. + {planContent: ($pc | .[:51200]), planFile: $pf}')" || true
        fi
      fi
    fi

    # Extract assistant text since last user message (what Claude said before this tool call)
    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
      RESPONSE="$(tail -30 "$TRANSCRIPT_PATH" | "$JQ" -rs '
        (to_entries | map(select(.value.type == "user")) | last | .key) as $last_user |
        to_entries | map(select(.key > ($last_user // -1))) |
        map(.value) | map(select(.type == "assistant")) |
        map(.message.content | map(select(.type == "text")) | map(.text)) |
        flatten | join("\n")
      ' 2>/dev/null)" || true
      if [ -n "$RESPONSE" ]; then
        ASSISTANT_TEXT="$(echo "$RESPONSE" | tail -c 4000)"
      fi
    fi
    ;;

  post_tool_use)
    TOOL="$(echo "$INPUT" | "$JQ" -r '.tool_name // ""')"
    TOOL_INPUT="$(echo "$INPUT" | "$JQ" -c '.tool_input // {}')"
    TOOL_USE_ID="$(echo "$INPUT" | "$JQ" -r '.tool_use_id // ""')"
    # Determine success from tool_result (if it contains error indicators)
    TOOL_RESULT="$(echo "$INPUT" | "$JQ" -r '.tool_result // ""' 2>/dev/null | head -c 500)"
    if echo "$TOOL_RESULT" | grep -qi "error\|failed\|exception\|ENOENT\|EACCES\|permission denied" 2>/dev/null; then
      SUCCESS="false"
      ERROR="$(echo "$TOOL_RESULT" | head -c 200)"
    else
      SUCCESS="true"
    fi
    ;;

  stop)
    TRANSCRIPT_PATH="$(echo "$INPUT" | "$JQ" -r '.transcript_path // ""')"

    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
      # Search last 10 lines for the most recent assistant message
      # (transcript ends with system/progress entries after the assistant message)
      RESPONSE=""
      while IFS= read -r line; do
        MAYBE="$(echo "$line" | "$JQ" -r '
          select(.type == "assistant") |
          .message.content // [] | map(select(.type == "text") | .text) | join("\n")
        ' 2>/dev/null)" || true
        if [ -n "$MAYBE" ]; then
          RESPONSE="$MAYBE"
        fi
      done < <(tail -10 "$TRANSCRIPT_PATH" 2>/dev/null)

      if [ -n "$RESPONSE" ]; then
        # Take last 4000 chars for assistantText
        ASSISTANT_TEXT="$(echo "$RESPONSE" | tail -c 4000)"

        # Look for <!--rc:CATEGORY:MESSAGE--> pattern (also escaped variant)
        # Use perl for reliable regex extraction
        MARKER_RAW="$(echo "$RESPONSE" | perl -ne '
          if (/<\\?!--rc:(\w+):?(.*?)-->/) {
            my ($cat, $msg) = ($1, $2);
            $msg =~ s/^\s+|\s+$//g;
            # Escape for JSON
            $msg =~ s/\\/\\\\/g;
            $msg =~ s/"/\\"/g;
            $msg =~ s/\n/\\n/g;
            $msg =~ s/\r/\\r/g;
            $msg =~ s/\t/\\t/g;
            print "{\"category\":\"$cat\",\"message\":\"$msg\"}";
            exit 0;
          }
        ' 2>/dev/null)" || true

        if [ -n "$MARKER_RAW" ]; then
          # Validate it's proper JSON before using
          if echo "$MARKER_RAW" | "$JQ" empty 2>/dev/null; then
            MARKER_JSON="$MARKER_RAW"
          fi
        fi
      fi

      # Extract token usage from last assistant message (context window + output = what terminal shows)
      TOKEN_SUM="$("$JQ" -r 'select(.type == "assistant") | .message.usage | "\((.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0) + (.output_tokens // 0))"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1)" || true
      if [ -n "$TOKEN_SUM" ] && [ "$TOKEN_SUM" != "0" ]; then
        TOTAL_TOKENS="$TOKEN_SUM"
      fi
    fi
    ;;

  notification)
    TOOL="$(echo "$INPUT" | "$JQ" -r '.tool_name // ""')"
    TOOL_INPUT="$(echo "$INPUT" | "$JQ" -c '.tool_input // {}')"
    TRANSCRIPT_PATH="$(echo "$INPUT" | "$JQ" -r '.transcript_path // ""')"

    # For ExitPlanMode, read the most recently modified plan file
    if [ "$TOOL" = "ExitPlanMode" ]; then
      PLANS_DIR="$HOME/.claude/plans"
      if [ -d "$PLANS_DIR" ]; then
        PLAN_FILE="$(ls -t "$PLANS_DIR"/*.md 2>/dev/null | head -1)"
        if [ -n "$PLAN_FILE" ] && [ -f "$PLAN_FILE" ]; then
          TOOL_INPUT="$(echo "$TOOL_INPUT" | "$JQ" -c --rawfile pc "$PLAN_FILE" --arg pf "$PLAN_FILE" '. + {planContent: ($pc | .[:51200]), planFile: $pf}')" || true
        fi
      fi
    fi

    # Extract assistant text for context (what Claude said before this notification)
    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
      RESPONSE="$(tail -30 "$TRANSCRIPT_PATH" | "$JQ" -rs '
        (to_entries | map(select(.value.type == "user")) | last | .key) as $last_user |
        to_entries | map(select(.key > ($last_user // -1))) |
        map(.value) | map(select(.type == "assistant")) |
        map(.message.content | map(select(.type == "text")) | map(.text)) |
        flatten | join("\n")
      ' 2>/dev/null)" || true
      if [ -n "$RESPONSE" ]; then
        ASSISTANT_TEXT="$(echo "$RESPONSE" | tail -c 4000)"
      fi
    fi
    ;;

  user_prompt_submit)
    ASSISTANT_TEXT="$(echo "$INPUT" | "$JQ" -r '.prompt // ""')"
    ;;

  session_start|session_end)
    # No extra fields to extract
    ;;
esac

# --- Build the ClaudeEvent JSON ---
# Use jq to safely construct JSON (handles escaping properly)
EVENT_JSON="$(
  "$JQ" -n -c \
    --arg id "$EVENT_ID" \
    --argjson timestamp "$TIMESTAMP_MS" \
    --arg type "$EVENT_TYPE" \
    --arg sessionId "$SESSION_ID" \
    --arg cwd "$CWD" \
    --arg tool "$TOOL" \
    --argjson toolInput "$TOOL_INPUT" \
    --arg toolUseId "$TOOL_USE_ID" \
    --argjson success "$SUCCESS" \
    --arg error "$ERROR" \
    --arg assistantText "$ASSISTANT_TEXT" \
    --argjson marker "$MARKER_JSON" \
    --arg tmuxTarget "$TMUX_TARGET" \
    --arg gitBranch "$GIT_BRANCH" \
    --arg gitDirty "$GIT_DIRTY" \
    --argjson totalTokens "$TOTAL_TOKENS" \
    '{
      id: $id,
      timestamp: $timestamp,
      type: $type,
      sessionId: $sessionId,
      cwd: $cwd
    }
    + (if $tool != "" then {tool: $tool} else {} end)
    + (if $toolInput != {} then {toolInput: $toolInput} else {} end)
    + (if $toolUseId != "" then {toolUseId: $toolUseId} else {} end)
    + (if $success != null then {success: $success} else {} end)
    + (if $error != "" then {error: $error} else {} end)
    + (if $assistantText != "" then {assistantText: $assistantText} else {} end)
    + (if $marker != null then {marker: $marker} else {} end)
    + (if $tmuxTarget != "" then {tmuxTarget: $tmuxTarget} else {} end)
    + (if $gitBranch != "" then {gitBranch: $gitBranch} else {} end)
    + (if $gitDirty == "true" then {gitDirty: true} else {} end)
    + (if $totalTokens != null then {totalTokens: $totalTokens} else {} end)
    '
)" || {
  echo "remote-claude-hook: ERROR: failed to build event JSON" >&2
  exit 0
}

# --- Append to JSONL file ---
echo "$EVENT_JSON" >> "$EVENTS_FILE" 2>/dev/null || {
  echo "remote-claude-hook: WARNING: failed to write to $EVENTS_FILE" >&2
}

# --- POST to server (backgrounded, fire and forget) ---
(
  HOOK_HEADERS=(-H "Content-Type: application/json")
  if [ -n "$HOOK_SECRET" ]; then
    HOOK_HEADERS+=(-H "X-Hook-Secret: $HOOK_SECRET")
  fi
  curl -s -o /dev/null -X POST \
    "${HOOK_HEADERS[@]}" \
    -d "$EVENT_JSON" \
    --connect-timeout 2 \
    --max-time 5 \
    "$SERVER_URL" 2>/dev/null
) &

# --- Done ---
exit 0
