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
[ "${MARKETING_MEDIA_JOB_PULLED:-}" = 1 ] || MARKETING_MEDIA_JOB_PULLED=1 exec bash "$PWD/run-daily.sh" "$@"
# The pull can replace this file while bash is still reading it: on 2026-11-05
# the CLI call was read from the middle of the new file and lost its flags. So
# the pulled copy runs again from the top. Everything above the line before
# this comment stays byte for byte as it is, because a running older copy
# reads on from exactly there.
npm ci --no-audit --no-fund --silent
npx --yes remotion browser ensure >/dev/null
npx --yes playwright install chromium >/dev/null
mkdir -p job

# The flags the box's other unattended CLI runs use (lib/amux/ideaTrackedCheckoutCli.ts):
# no prompts, no session kept, and only these tools. The whole stream stays in job/
# (not in git): plain text keeps only the last line, and a run that dies early
# ("Prompt is too long", 2026-11-04) then says nothing about what it had read.
# No MCP: the job uses none, and with ToolSearch left out of --tools every MCP
# tool of the account's claude.ai connectors is loaded into the prompt up front
# (code.claude.com/docs/en/mcp.md), the likely cause of that 2026-11-04 failure.
ENABLE_CLAUDEAI_MCP_SERVERS=false "${CLAUDE_BIN:-claude}" --print "$(cat JOB.md)" \
  --no-session-persistence \
  --permission-mode dontAsk --permission-prompts none \
  --strict-mcp-config \
  --tools "Bash,Read,Write,Edit" \
  --allowedTools "Bash(node *),Bash(npx *),Read,Write,Edit" \
  --disallowedTools "mcp__*" \
  --max-turns 200 \
  --output-format stream-json --verbose \
  | tee -a "job/run-$(date -u +%Y%m%d).jsonl" \
  | node print-run-result.mjs \
  | tee -a "job/run-$(date -u +%Y%m%d).log"
