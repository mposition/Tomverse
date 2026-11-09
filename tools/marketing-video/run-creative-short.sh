#!/usr/bin/env bash
# The creative short job on the AMUX box (owner 2026-11-09), run by hand:
#   set -a; . ~/.config/tomverse/marketing-video.prod.env; set +a
#   bash tools/marketing-video/run-creative-short.sh
# Off unless MARKETING_CREATIVE_SHORT=on in that env file. It also needs
# MARKETING_CREATIVE_SHORT_DAILY_CREDIT_CAP (Higgsfield credits a day),
# MARKETING_CREATIVE_SHORT_DAILY_VOICE_CHARS (ElevenLabs characters a day) and
# ELEVENLABS_API_KEY; without any of them it stops before spending anything.
# No cron starts it yet.
set -euo pipefail

cd "$(dirname "$0")"
git -C ../.. pull --ff-only --quiet
[ "${MARKETING_CREATIVE_SHORT_PULLED:-}" = 1 ] || MARKETING_CREATIVE_SHORT_PULLED=1 exec bash "$PWD/run-creative-short.sh" "$@"
# The pulled copy runs again from the top (see run-daily.sh).
npm ci --no-audit --no-fund --silent
npx --yes remotion browser ensure >/dev/null
mkdir -p job
export PATH="$HOME/.local/bin:$PATH"
node run-creative-short.mjs | tee -a "job/creative-$(date -u +%Y%m%d).log"
exit "${PIPESTATUS[0]}"
