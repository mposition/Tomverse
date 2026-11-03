#!/usr/bin/env bash
# The daily marketing video job on the AMUX box (owner approval 2026-10-31).
# Run from cron with MARKETING_APP_URL and MARKETING_MEDIA_SUBMIT_SECRET in the
# environment (an env file the operator keeps on the box, never in git).
# The Claude Code CLI follows JOB.md; it may run node, npx and file tools here
# and nothing else. It submits assets only: nothing it does publishes.
set -euo pipefail

cd "$(dirname "$0")"
: "${MARKETING_APP_URL:?MARKETING_APP_URL is not set}"
: "${MARKETING_MEDIA_SUBMIT_SECRET:?MARKETING_MEDIA_SUBMIT_SECRET is not set}"

git -C ../.. pull --ff-only --quiet
npm ci --no-audit --no-fund --silent
npx --yes remotion browser ensure >/dev/null
npx --yes playwright install chromium >/dev/null
mkdir -p job

# The flags the box's other unattended CLI runs use (lib/amux/ideaTrackedCheckoutCli.ts):
# no prompts, no session kept, and only these tools.
"${CLAUDE_BIN:-claude}" --print "$(cat JOB.md)" \
  --no-session-persistence \
  --permission-mode dontAsk --permission-prompts none \
  --tools "Bash,Read,Write,Edit" \
  --allowedTools "Bash(node *),Bash(npx *),Read,Write,Edit" \
  --max-turns 120 \
  | tee -a "job/run-$(date -u +%Y%m%d).log"
