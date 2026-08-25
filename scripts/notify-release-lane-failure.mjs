/**
 * Post a release-lane failure to Slack. Never fails the job that calls it.
 *
 * Decisions and their reasons live in
 * `scripts/notify-release-lane-failure-core.mjs`; this file only reads the
 * environment, calls the network, and prints what happened.
 *
 * Usage from a workflow, as the last step of a job that may have failed:
 *
 *   - name: Report a red release lane
 *     if: always()
 *     env:
 *       RELEASE_LANE: back-merge
 *       RELEASE_LANE_CONCLUSION: ${{ job.status }}
 *       RELEASE_LANE_ALERT_SLACK_WEBHOOK_URL: ${{ secrets.… }}
 *     run: node scripts/notify-release-lane-failure.mjs
 */

import {
  buildReleaseLaneFailureMessage,
  LANE_KEYS,
  RELEASE_LANE_ALERT_WEBHOOK_ENV_NAMES,
  resolveReleaseLaneAlert,
  resolveWebhookUrl,
} from "./notify-release-lane-failure-core.mjs";

const env = process.env;
const lane = (env.RELEASE_LANE || "").trim();

// A lane name that carries no consequence text would send "something failed",
// which is the message this script exists to replace. Said once, loudly, and
// still without failing the job.
if (!LANE_KEYS.includes(lane)) {
  console.error(
    `RELEASE_LANE must be one of ${LANE_KEYS.join(", ")}; got ${
      lane || "(unset)"
    }. No notification sent.`
  );
  process.exit(0);
}

const { name: webhookEnvName, url: webhookUrl } = resolveWebhookUrl(env);
const decision = resolveReleaseLaneAlert({
  conclusion: env.RELEASE_LANE_CONCLUSION,
  branch: env.RELEASE_LANE_BRANCH,
  webhookUrl,
});

if (!decision.send) {
  const explanations = {
    not_a_failure: "the lane did not fail, so there is nothing to report",
    not_a_release_branch:
      "this is not a release branch; a red feature branch is already visible on its pull request",
    not_configured: `no webhook is configured (checked ${RELEASE_LANE_ALERT_WEBHOOK_ENV_NAMES.join(", ")})`,
    webhook_not_https: "the configured webhook is not an HTTPS URL",
  };
  console.log(
    `No release-lane notification sent: ${
      explanations[decision.reason] || decision.reason
    }.`
  );
  process.exit(0);
}

const message = buildReleaseLaneFailureMessage({
  lane,
  workflowName: env.RELEASE_LANE_WORKFLOW,
  branch: env.RELEASE_LANE_BRANCH,
  commitSha: env.RELEASE_LANE_SHA,
  commitMessage: env.RELEASE_LANE_COMMIT_MESSAGE,
  runUrl: env.RELEASE_LANE_RUN_URL,
});

try {
  const response = await fetch(decision.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `<!channel>\n${message}`.slice(0, 3_000) }),
  });
  if (!response.ok) {
    console.error(
      `Release-lane notification failed: webhook returned ${response.status}.`
    );
  } else {
    console.log(
      `Release-lane notification sent via ${webhookEnvName} for ${lane}.`
    );
  }
} catch (error) {
  console.error(
    `Release-lane notification failed: ${
      error instanceof Error ? error.message : "unknown error"
    }.`
  );
}
