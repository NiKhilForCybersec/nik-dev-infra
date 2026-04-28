#!/usr/bin/env bash
# verify-memnik-integration.sh
#
# Idempotent health check: confirms that this dev-infra daemon is in a
# healthy state to be consumed by the memnik-os bridge. Validates the WS
# contract documented in docs/MEMNIK_INTEGRATION.md.
#
# Exit codes:
#   0  — dev-infra is healthy and ready for memnik bridge to connect
#   1  — daemon down / unreachable
#   2  — schema drift (required field missing or unexpected key shape)
#   3  — findings.jsonl missing or empty
#   4  — jq missing
#
# Usage:
#   ./scripts/verify-memnik-integration.sh
#   ./scripts/verify-memnik-integration.sh --json     # machine-readable
#
# Read-only by design. Never modifies dev-infra state.

set -uo pipefail

DAEMON_HOST="${DEV_INFRA_HOST:-127.0.0.1}"
DAEMON_PORT="${DEV_INFRA_PORT:-5175}"
DAEMON_URL="http://${DAEMON_HOST}:${DAEMON_PORT}"
FINDINGS_FILE="${DEV_INFRA_FINDINGS:-data/findings.jsonl}"

JSON_OUT=0
[[ "${1:-}" == "--json" ]] && JSON_OUT=1

# ─── helpers ─────────────────────────────────────────────────────────

green() { printf '\033[0;32m%s\033[0m' "$1"; }
red()   { printf '\033[0;31m%s\033[0m' "$1"; }
yellow(){ printf '\033[0;33m%s\033[0m' "$1"; }

emit_text() {
    local label="$1" status="$2" detail="$3"
    case "$status" in
        ok)   printf '  [%s] %-40s %s\n' "$(green "✓")" "$label" "$detail" ;;
        warn) printf '  [%s] %-40s %s\n' "$(yellow "!")" "$label" "$detail" ;;
        fail) printf '  [%s] %-40s %s\n' "$(red "✗")" "$label" "$detail" ;;
    esac
}

emit_json_kv() {
    # Append a key=value pair to a global json buffer
    JSON_PAIRS+=("\"$1\":$2")
}

JSON_PAIRS=()
FAIL_REASON=""
EXIT_CODE=0

fail() {
    FAIL_REASON="$1"
    EXIT_CODE="$2"
}

# ─── pre-flight ──────────────────────────────────────────────────────

if ! command -v jq >/dev/null 2>&1; then
    if (( JSON_OUT )); then
        echo '{"ok":false,"reason":"jq not installed"}'
    else
        emit_text "jq installed" fail "jq is required (brew install jq)"
    fi
    exit 4
fi

# ─── 1. daemon reachable ─────────────────────────────────────────────

SNAPSHOT=$(curl -fsS -m 5 "$DAEMON_URL/api/snapshot" 2>/dev/null) || {
    if (( JSON_OUT )); then
        echo "{\"ok\":false,\"reason\":\"daemon unreachable at ${DAEMON_URL}\"}"
    else
        emit_text "daemon reachable" fail "no response from ${DAEMON_URL}/api/snapshot"
        echo
        echo "  Recovery: cd $(pwd) && npm start"
    fi
    exit 1
}
emit_json_kv "daemon_url" "\"${DAEMON_URL}\""

# ─── 2. snapshot has findings array ──────────────────────────────────

FINDING_COUNT=$(echo "$SNAPSHOT" | jq -r '.findings | length // 0' 2>/dev/null)
if [[ -z "$FINDING_COUNT" || "$FINDING_COUNT" == "null" ]]; then
    fail "snapshot has no .findings array" 2
    FINDING_COUNT=0
fi
emit_json_kv "finding_count" "$FINDING_COUNT"

# ─── 3. schema check ─────────────────────────────────────────────────

REQUIRED_KEYS='["agent","at","id","kind","severity","summary"]'
SAMPLE_KEYS=$(echo "$SNAPSHOT" | jq -c '.findings[0] // empty | keys')
SCHEMA_OK="true"
SCHEMA_DETAIL=""

if [[ -z "$SAMPLE_KEYS" ]]; then
    SCHEMA_OK="false"
    SCHEMA_DETAIL="no findings to sample (daemon may have just started)"
else
    MISSING=$(jq -nc --argjson sample "$SAMPLE_KEYS" --argjson req "$REQUIRED_KEYS" \
        '$req - $sample')
    if [[ "$MISSING" != "[]" ]]; then
        SCHEMA_OK="false"
        SCHEMA_DETAIL="missing required keys: $MISSING"
        fail "$SCHEMA_DETAIL" 2
    fi

    ALLOWED='["id","agent","kind","at","severity","summary","file","line","suggestion","payload"]'
    EXTRAS=$(jq -nc --argjson sample "$SAMPLE_KEYS" --argjson allowed "$ALLOWED" \
        '$sample - $allowed')
    if [[ "$EXTRAS" != "[]" ]]; then
        SCHEMA_OK="warn"
        SCHEMA_DETAIL="unexpected keys (potential schema drift): $EXTRAS"
    elif [[ "$SCHEMA_OK" == "true" ]]; then
        SCHEMA_DETAIL="contract met (id, agent, kind, at, severity, summary + optional file/line/suggestion/payload)"
    fi
fi
emit_json_kv "schema_ok" "$([[ "$SCHEMA_OK" == "true" ]] && echo true || echo false)"
emit_json_kv "schema_sample_keys" "$SAMPLE_KEYS"

# ─── 4. findings persistence ─────────────────────────────────────────

JSONL_LINES=0
if [[ -f "$FINDINGS_FILE" ]]; then
    JSONL_LINES=$(wc -l < "$FINDINGS_FILE" | tr -d ' ')
    PERSIST_OK=true
else
    fail "$FINDINGS_FILE not found" 3
    PERSIST_OK=false
fi
emit_json_kv "jsonl_lines" "$JSONL_LINES"

# ─── 5. websocket port listening ─────────────────────────────────────

WS_OK=false
if lsof -nP -iTCP:"$DAEMON_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    WS_OK=true
fi
emit_json_kv "ws_listening" "$([[ "$WS_OK" == "true" ]] && echo true || echo false)"

# ─── output ──────────────────────────────────────────────────────────

if (( JSON_OUT )); then
    OK="true"
    [[ "$EXIT_CODE" -ne 0 ]] && OK="false"
    JSON_PAIRS+=("\"ok\":$OK")
    [[ -n "$FAIL_REASON" ]] && JSON_PAIRS+=("\"reason\":\"$FAIL_REASON\"")
    printf '{%s}\n' "$(IFS=,; echo "${JSON_PAIRS[*]}")"
    exit "$EXIT_CODE"
fi

echo
echo "  memnik-os ↔ dev-infra integration health"
echo "  ─────────────────────────────────────────"
emit_text "daemon reachable" ok "${DAEMON_URL}"

if [[ "$WS_OK" == "true" ]]; then
    emit_text "WS port :${DAEMON_PORT} listening" ok "loopback (127.0.0.1) — bridge can connect"
else
    emit_text "WS port :${DAEMON_PORT} listening" warn "lsof did not see a listener (HTTP responded though — may be fine)"
fi

if [[ "$FINDING_COUNT" -gt 0 ]]; then
    emit_text "snapshot finding count" ok "${FINDING_COUNT} in ring buffer"
else
    emit_text "snapshot finding count" warn "0 findings (daemon may have just started)"
fi

case "$SCHEMA_OK" in
    true) emit_text "schema contract" ok "$SCHEMA_DETAIL" ;;
    warn) emit_text "schema contract" warn "$SCHEMA_DETAIL" ;;
    *)    emit_text "schema contract" fail "$SCHEMA_DETAIL" ;;
esac

if [[ "$PERSIST_OK" == "true" ]]; then
    emit_text "findings.jsonl" ok "${JSONL_LINES} lines (id stability surface)"
else
    emit_text "findings.jsonl" fail "$FINDINGS_FILE not found"
fi

echo
if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo "  $(green "READY") — memnik bridge can connect to ws://${DAEMON_HOST}:${DAEMON_PORT}/ws"
    echo "          Boot order: T1 dev-infra (here, ✓) → T2 memnik start → T3 memnik dashboard → T4 user repo"
else
    echo "  $(red "NOT READY") — $FAIL_REASON"
    echo "  See docs/MEMNIK_INTEGRATION.md § Recovery flows"
fi
echo

exit "$EXIT_CODE"
