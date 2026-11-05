#!/usr/bin/env bash
# The daily marketing media job on the AMUX box (owner approval 2026-10-31;
# cards and feed videos made only from approved assets, 2026-11-04).
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
# no prompts, no session kept, and only these tools. The whole stream stays in job/
# (not in git): plain text keeps only the last line, and a run that dies early
# ("Prompt is too long", 2026-11-04) then says nothing about what it had read.
"${CLAUDE_BIN:-claude}" --print "$(cat JOB.md)" \
  --no-session-persistence \
  --permission-mode dontAsk --permission-prompts none \
  --tools "Bash,Read,Write,Edit" \
  --allowedTools "Bash(node *),Bash(npx *),Read,Write,Edit" \
  --max-turns 120 \
  --output-format stream-json --verbose \
  | tee -a "job/run-$(date -u +%Y%m%d).jsonl" \
  | node print-run-result.mjs \
  | tee -a "job/run-$(date -u +%Y%m%d).log"
