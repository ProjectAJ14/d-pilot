#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  D-Pilot Deploy — Stash · Pull · Install · Build · Restart  ║
# ╚══════════════════════════════════════════════════════════════╝

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Spinner (ASCII-safe) ────────────────────────────────────────
SPIN_FRAMES=('/' '-' '\' '|')
SPIN_PID=""

spinner_start() {
    local msg="$1"
    (
        i=0
        while true; do
            printf "\r  ${CYAN}${SPIN_FRAMES[$((i % 4))]}${RESET} %s" "$msg" >&2
            i=$((i + 1))
            sleep 0.1
        done
    ) &
    SPIN_PID=$!
}

spinner_stop() {
    local symbol="$1" msg="$2"
    if [[ -n "$SPIN_PID" ]]; then
        kill "$SPIN_PID" 2>/dev/null
        wait "$SPIN_PID" 2>/dev/null || true
        SPIN_PID=""
    fi
    printf "\r  %b %b\033[K\n" "$symbol" "$msg" >&2
}

trap '[[ -n "${SPIN_PID:-}" ]] && kill "$SPIN_PID" 2>/dev/null' EXIT

# ── Resolve script directory ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Steps ────────────────────────────────────────────────────────
STEPS=(
    "git stash|Stashing local changes"
    "git pull|Pulling latest code"
    "npm install|Installing dependencies"
    "npm run build|Building project"
    "systemctl restart d-pilot|Restarting service"
)

TOTAL=${#STEPS[@]}
PASSED=0
FAILED_STEP=""

# ── Banner ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}  ╭─────────────────────────────────────╮${RESET}"
echo -e "${BOLD}${CYAN}  │        D-Pilot Deploy Script        │${RESET}"
echo -e "${BOLD}${CYAN}  ╰─────────────────────────────────────╯${RESET}"
echo ""

# ── Run Steps ────────────────────────────────────────────────────
LOGFILE=$(mktemp /tmp/dpilot-deploy-XXXXXX.log)

for i in "${!STEPS[@]}"; do
    entry="${STEPS[$i]}"
    cmd="${entry%%|*}"
    label="${entry##*|}"
    step=$((i + 1))

    spinner_start "[${step}/${TOTAL}] ${label}..."

    if $cmd > "$LOGFILE" 2>&1; then
        spinner_stop "${GREEN}OK${RESET}" "${DIM}[${step}/${TOTAL}]${RESET} ${label}"
        PASSED=$((PASSED + 1))
    else
        spinner_stop "${RED}x${RESET}" "${DIM}[${step}/${TOTAL}]${RESET} ${RED}${label} -- failed${RESET}"
        FAILED_STEP="${label}"
        echo ""
        echo -e "  ${RED}${BOLD}Last 10 lines of output:${RESET}"
        tail -10 "$LOGFILE" | sed 's/^/    /'
        break
    fi
done

rm -f "$LOGFILE"

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}  ╭─────────────────────────────────────╮${RESET}"
echo -e "${BOLD}${CYAN}  │            Results                  │${RESET}"
echo -e "${BOLD}${CYAN}  ├─────────────────────────────────────┤${RESET}"
printf "${BOLD}${CYAN}  │${RESET}  ${GREEN}Passed:${RESET}  %-26s${BOLD}${CYAN}│${RESET}\n" "${PASSED}/${TOTAL} step(s)"
if [[ -n "$FAILED_STEP" ]]; then
    printf "${BOLD}${CYAN}  │${RESET}  ${RED}Failed:${RESET}  %-26s${BOLD}${CYAN}│${RESET}\n" "$FAILED_STEP"
fi
echo -e "${BOLD}${CYAN}  ╰─────────────────────────────────────╯${RESET}"

echo ""
if [[ -z "$FAILED_STEP" ]]; then
    echo -e "  ${GREEN}${BOLD}Deploy complete!${RESET} Checking service status..."
    echo ""
    systemctl status d-pilot --no-pager 2>&1 | sed 's/^/    /'
else
    echo -e "  ${RED}${BOLD}Deploy failed${RESET} at: ${YELLOW}${FAILED_STEP}${RESET}"
    echo -e "  ${DIM}Fix the issue and re-run.${RESET}"
fi
echo ""
