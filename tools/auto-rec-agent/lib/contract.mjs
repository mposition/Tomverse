/**
 * Every name this tool shares with something outside it: the app's internal
 * recommendation API, the GitHub repository, the branch namespace Auto PR to
 * Develop opens pull requests for, and the outcome codes the app stores.
 *
 * The app side of the API is built separately. When its route names, header
 * or body shape change, this file is the one place to follow it.
 */

// App API. Both routes take the shared secret as a bearer token, like the
// other internal routes the Ubuntu host calls (review-orchestrator status).
export const APP_CLAIM_PATH = "/api/internal/auto-router/recommendations/claim";
export const APP_RESULT_PATH = "/api/internal/auto-router/recommendations/result";
export const appRequestHeaders = (secret) => ({
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
  accept: "application/json",
});

export const OUTCOME_PR_OPENED = "pr_opened";
export const OUTCOME_FAILED = "failed";

/**
 * Failure reasons the runner reports. Codes only: the app gets no free text,
 * so nothing the agent or a test printed can reach it. README has the table.
 */
export const FAILURE_REASONS = Object.freeze([
  "out_of_scope",
  "no_change",
  "tests",
  "review_reject",
  "review_unknown",
  "agent_error",
  "timeout",
  "lease_expired",
  "setup_failed",
  "runner_error",
  "rate_limited",
  "push_rejected",
  "push_failed",
  "pr_failed",
]);

// GitHub.
export const REPO_SLUG = "mposition/Tomverse";
export const REPO_OWNER = "mposition";
export const REPO_URL = `https://github.com/${REPO_SLUG}.git`;
export const GITHUB_API = "https://api.github.com";
export const PR_URL_PATTERN = /^https:\/\/github\.com\/mposition\/Tomverse\/pull\/[1-9][0-9]{0,8}$/;

// Auto PR to Develop opens a pull request only for a branch with a
// `to-develop` path segment (scripts/auto-pr-branch-policy.mjs).
export const BRANCH_PREFIX = "claude/to-develop/auto-rec-";
export const BRANCH_PATTERN = /^claude\/to-develop\/auto-rec-[a-z0-9]{1,24}-[0-9a-f]{8}$/;

// Server layout (decided with the operator, 2026-10-20).
export const DEFAULTS = Object.freeze({
  home: "/home/autorec",
  mirror: "/home/autorec/mirror/Tomverse",
  workDir: "/home/autorec/work",
  logDir: "/home/autorec/logs",
  claudeBin: "/home/autorec/.local/bin/claude",
  gatewaySocket: "/run/autorec-gateway.sock",
  reviewClient: "/usr/local/lib/autorec-agent/tools/review-orchestrator/client/review.mjs",
});

// Limits. The run is one recommendation per hourly timer tick.
export const LIMITS = Object.freeze({
  claudeMs: 30 * 60_000,
  testsMs: 15 * 60_000,
  lintMs: 5 * 60_000,
  setupMs: 30 * 60_000,
  reviewWaitMs: 60 * 60_000,
  // Publishing must start this long before the app's lease ends, so the
  // result reaches the app while the lease is still the runner's.
  leaseMarginMs: 5 * 60_000,
  // The gateway never publishes more than the hourly timer could ask for.
  publishesPerDay: 24,
  autoPrWaitMs: 5 * 60_000,
  autoPrPollMs: 15_000,
  bundleBytes: 50 * 1024 * 1024,
  headerBytes: 256 * 1024,
  instructionChars: 20_000,
  findingsChars: 8_000,
  logRetentionDays: 30,
});

export const GIT_IDENTITY = Object.freeze({
  name: "tomverse-auto-rec[bot]",
  email: "tomverse-auto-rec-bot@users.noreply.github.com",
});
