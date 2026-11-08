#!/usr/bin/env bash
#
# Installs the pinned gitleaks binary and scans this checkout's git history,
# for the three workflows that used to run gitleaks/gitleaks-action@v3
# (pr-fast-gate, secret-history-scan, daily-security-audit).
#
# Why not the action: it downloads only from the release web path
# (github.com/<owner>/<repo>/releases/download/...). On 2026-11-08 that path
# returned 504 for every repository while the REST asset path served the same
# file, and PR Fast Gate failed three times in a row with "could not install
# gitleaks". Here the binary comes from the REST asset endpoint first and the
# web path only as a fallback, and either copy must match both the sha256
# pinned below and the release's own checksums file before it runs.
#
# The scan is the action's, event by event:
#   pull_request        --no-merges --first-parent merge-base(base, head)..head
#                       (the action took the first and last commit of the PR's
#                       first API page, 30 commits, so a longer PR lost its
#                       newest commits; this is the same range without the cap)
#   push                --no-merges --first-parent commits[0]^..commits[-1],
#                       or the one commit when the push carried one
#   schedule, dispatch  the whole history
# with the action's flags (--redact, --exit-code=2, SARIF to results.sarif).
# gitleaks finds .gitleaks.toml and .gitleaksignore in the working directory
# itself, as it did under the action. Exit status: 0 clean, 1 leaks found,
# anything else is gitleaks' own error code.
#
# Usage: scripts/ci/gitleaks-scan.sh   (from the repository root, after a
# fetch-depth: 0 checkout). GITHUB_TOKEN, when set, authenticates the asset
# download so it does not share the runner IP's anonymous rate limit.

set -euo pipefail

readonly GITLEAKS_VERSION="8.24.3"
readonly GITLEAKS_REPO="gitleaks/gitleaks"
readonly ARCHIVE_NAME="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
readonly ARCHIVE_ASSET_ID="245568496"
readonly ARCHIVE_SHA256="9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c"
readonly CHECKSUMS_NAME="gitleaks_${GITLEAKS_VERSION}_checksums.txt"
readonly CHECKSUMS_ASSET_ID="245568489"
readonly EXIT_CODE_LEAKS_DETECTED=2

work_dir="${RUNNER_TEMP:-$(mktemp -d)}/gitleaks-${GITLEAKS_VERSION}"
mkdir -p "$work_dir"

# fetch <asset id> <asset name> <output path>
fetch() {
  local asset_id="$1" name="$2" out="$3"
  local auth=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi
  # curl does not forward the Authorization header across the redirect to the
  # asset storage host, which is what we want.
  if curl --fail --silent --show-error --location \
      --retry 4 --retry-all-errors --retry-delay 5 --max-time 120 \
      "${auth[@]}" -H "Accept: application/octet-stream" \
      -o "$out" \
      "https://api.github.com/repos/${GITLEAKS_REPO}/releases/assets/${asset_id}"; then
    echo "Downloaded ${name} from the release asset API."
    return 0
  fi
  echo "::warning::release asset API failed for ${name}; trying the release download path."
  curl --fail --silent --show-error --location \
    --retry 4 --retry-all-errors --retry-delay 5 --max-time 120 \
    -o "$out" \
    "https://github.com/${GITLEAKS_REPO}/releases/download/v${GITLEAKS_VERSION}/${name}"
  echo "Downloaded ${name} from the release download path."
}

install_gitleaks() {
  local archive="${work_dir}/${ARCHIVE_NAME}"
  local checksums="${work_dir}/${CHECKSUMS_NAME}"
  fetch "$ARCHIVE_ASSET_ID" "$ARCHIVE_NAME" "$archive"
  fetch "$CHECKSUMS_ASSET_ID" "$CHECKSUMS_NAME" "$checksums"

  local published actual
  published="$(awk -v name="$ARCHIVE_NAME" '$2 == name { print $1 }' "$checksums")"
  actual="$(sha256sum "$archive" | awk '{ print $1 }')"
  if [ "$published" != "$ARCHIVE_SHA256" ]; then
    echo "::error::${CHECKSUMS_NAME} lists '${published}' for ${ARCHIVE_NAME}, not the pinned ${ARCHIVE_SHA256}."
    exit 1
  fi
  if [ "$actual" != "$ARCHIVE_SHA256" ]; then
    echo "::error::${ARCHIVE_NAME} sha256 is ${actual}, expected ${ARCHIVE_SHA256}."
    exit 1
  fi
  echo "${ARCHIVE_NAME} sha256 ${actual} matches the pin and ${CHECKSUMS_NAME}."

  tar -xzf "$archive" -C "$work_dir" gitleaks
  GITLEAKS_BIN="${work_dir}/gitleaks"
  local version
  version="$("$GITLEAKS_BIN" version)"
  if [ "$version" != "$GITLEAKS_VERSION" ]; then
    echo "::error::gitleaks ${GITLEAKS_VERSION} required, got '${version}'."
    exit 1
  fi
}

# Sets LOG_OPTS for the event, or exits 0 when a push carried no commits.
scan_range() {
  LOG_OPTS=""
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request)
      local base head merge_base
      base="$(jq -r '.pull_request.base.sha' "$GITHUB_EVENT_PATH")"
      head="$(jq -r '.pull_request.head.sha' "$GITHUB_EVENT_PATH")"
      merge_base="$(git merge-base "$base" "$head")"
      LOG_OPTS="--no-merges --first-parent ${merge_base}..${head}"
      ;;
    push)
      local count first last
      count="$(jq '.commits | length' "$GITHUB_EVENT_PATH")"
      if [ "$count" -eq 0 ]; then
        echo "No commits to scan"
        exit 0
      fi
      first="$(jq -r '.commits[0].id' "$GITHUB_EVENT_PATH")"
      last="$(jq -r '.commits[-1].id' "$GITHUB_EVENT_PATH")"
      if [ "$first" = "$last" ]; then
        LOG_OPTS="-1"
      else
        LOG_OPTS="--no-merges --first-parent ${first}^..${last}"
      fi
      ;;
    schedule | workflow_dispatch)
      ;;
    *)
      echo "::error::The [${GITHUB_EVENT_NAME:-}] event is not supported by the secret scan."
      exit 1
      ;;
  esac
}

write_summary() {
  local exit_code="$1"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  {
    if [ "$exit_code" -eq 0 ]; then
      echo "## Gitleaks: no leaks detected"
    elif [ "$exit_code" -eq "$EXIT_CODE_LEAKS_DETECTED" ]; then
      echo "## Gitleaks: leaks detected"
      echo
      echo "| Rule | Commit | File | Line |"
      echo "| --- | --- | --- | --- |"
      jq -r '.runs[0].results[]? | "| \(.ruleId) | \(.partialFingerprints.commitSha // "") | \(.locations[0].physicalLocation.artifactLocation.uri) | \(.locations[0].physicalLocation.region.startLine) |"' results.sarif || true
    else
      echo "## Gitleaks: error (exit ${exit_code})"
    fi
    echo
    echo "gitleaks ${GITLEAKS_VERSION}, event \`${GITHUB_EVENT_NAME:-}\`, log-opts \`${LOG_OPTS:-<whole history>}\`"
  } >> "$GITHUB_STEP_SUMMARY"
}

install_gitleaks
scan_range

args=(
  detect
  --redact
  -v
  "--exit-code=${EXIT_CODE_LEAKS_DETECTED}"
  --report-format=sarif
  --report-path=results.sarif
  --log-level=debug
)
if [ -n "$LOG_OPTS" ]; then
  args+=("--log-opts=${LOG_OPTS}")
fi

echo "gitleaks cmd: gitleaks ${args[*]}"
set +e
"$GITLEAKS_BIN" "${args[@]}"
exit_code=$?
set -e

write_summary "$exit_code"

if [ "$exit_code" -eq 0 ]; then
  echo "No leaks detected"
elif [ "$exit_code" -eq "$EXIT_CODE_LEAKS_DETECTED" ]; then
  echo "::warning::Leaks detected, see the job summary for details"
  exit 1
else
  echo "::error::Unexpected gitleaks exit code [${exit_code}]"
  exit "$exit_code"
fi
