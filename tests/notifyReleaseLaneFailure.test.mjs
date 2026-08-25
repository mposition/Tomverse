import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERTED_BRANCHES,
  buildReleaseLaneFailureMessage,
  LANE_CONSEQUENCES,
  LANE_KEYS,
  RELEASE_LANE_ALERT_WEBHOOK_ENV_NAMES,
  resolveReleaseLaneAlert,
  resolveWebhookUrl,
} from "../scripts/notify-release-lane-failure-core.mjs";

/* ------------------------------------------------------------------------ */
/* When to send                                                              */
/* ------------------------------------------------------------------------ */

const alert = (overrides = {}) =>
  resolveReleaseLaneAlert({
    conclusion: "failure",
    branch: "develop",
    webhookUrl: "https://hooks.example.com/x",
    ...overrides,
  });

test("a red release branch sends", () => {
  assert.equal(alert().send, true);
  assert.equal(alert({ branch: "main" }).send, true);
});

test("success and skipped send nothing", () => {
  for (const conclusion of ["success", "skipped", "neutral", ""]) {
    assert.equal(alert({ conclusion }).send, false);
    assert.equal(alert({ conclusion }).reason, "not_a_failure");
  }
});

test("a cancelled run is not an alert", () => {
  // A run cancelled by concurrency was superseded by one on a newer head that
  // contains it, so it answers nothing about the branch. Alerting on it would
  // send "unknown", and an alert nobody can act on is how alerts get muted.
  const decision = alert({ conclusion: "cancelled" });
  assert.equal(decision.send, false);
  assert.equal(decision.reason, "not_a_failure");
});

test("a feature branch is left to its own pull request", () => {
  const decision = alert({ branch: "claude/to-develop/something" });
  assert.equal(decision.send, false);
  assert.equal(decision.reason, "not_a_release_branch");
});

test("only main and develop are release branches", () => {
  assert.deepEqual(ALERTED_BRANCHES, ["main", "develop"]);
});

test("an unset webhook is a stated outcome, not a silent one", () => {
  // A repository that believes it has alerts and has none stops checking the
  // Actions tab, which is the state this whole script exists to leave.
  for (const webhookUrl of ["", "   ", undefined]) {
    const decision = alert({ webhookUrl });
    assert.equal(decision.send, false);
    assert.equal(decision.reason, "not_configured");
  }
});

test("a webhook that is not HTTPS is refused rather than posted to", () => {
  const decision = alert({ webhookUrl: "http://hooks.example.com/x" });
  assert.equal(decision.send, false);
  assert.equal(decision.reason, "webhook_not_https");
});

/* ------------------------------------------------------------------------ */
/* Which webhook                                                             */
/* ------------------------------------------------------------------------ */

test("the lane hook wins, then ops, then the general one", () => {
  assert.deepEqual(RELEASE_LANE_ALERT_WEBHOOK_ENV_NAMES, [
    "RELEASE_LANE_ALERT_SLACK_WEBHOOK_URL",
    "OPS_ALERT_SLACK_WEBHOOK_URL",
    "SLACK_WEBHOOK_URL",
  ]);
  assert.equal(
    resolveWebhookUrl({
      RELEASE_LANE_ALERT_SLACK_WEBHOOK_URL: "https://a",
      OPS_ALERT_SLACK_WEBHOOK_URL: "https://b",
      SLACK_WEBHOOK_URL: "https://c",
    }).url,
    "https://a"
  );
  assert.equal(
    resolveWebhookUrl({
      OPS_ALERT_SLACK_WEBHOOK_URL: "https://b",
      SLACK_WEBHOOK_URL: "https://c",
    }).url,
    "https://b"
  );
  assert.equal(resolveWebhookUrl({ SLACK_WEBHOOK_URL: "https://c" }).url, "https://c");
  assert.equal(resolveWebhookUrl({}).url, "");
});

test("a blank webhook variable does not shadow the next one", () => {
  assert.equal(
    resolveWebhookUrl({
      RELEASE_LANE_ALERT_SLACK_WEBHOOK_URL: "   ",
      OPS_ALERT_SLACK_WEBHOOK_URL: "https://b",
    }).url,
    "https://b"
  );
});

/* ------------------------------------------------------------------------ */
/* What it says                                                              */
/* ------------------------------------------------------------------------ */

const message = (overrides = {}) =>
  buildReleaseLaneFailureMessage({
    lane: "back-merge",
    workflowName: "Back-merge main into develop",
    branch: "main",
    commitSha: "e98169afa4d81c63e53b5e8ae3b2fae26cc7447c",
    commitMessage: "Merge pull request #969 from x\n\nbody that is not the subject",
    runUrl: "https://github.com/mposition/Tomverse/actions/runs/1",
    ...overrides,
  });

test("the message names the workflow, the branch, the commit and the run", () => {
  const text = message();
  assert.ok(text.includes("Back-merge main into develop"));
  assert.ok(text.includes("main"));
  assert.ok(text.includes("e98169af"));
  assert.ok(text.includes("https://github.com/mposition/Tomverse/actions/runs/1"));
});

test("only the commit subject travels, never the body", () => {
  const text = message();
  assert.ok(text.includes("Merge pull request #969 from x"));
  assert.equal(text.includes("body that is not the subject"), false);
});

test("the message states the consequence, not just the event", () => {
  // "Back-merge failed" means nothing to a reader who has not read the
  // workflow. The cost is what makes it actionable.
  const text = message();
  assert.ok(text.includes("SKIPPED"));
  assert.ok(text.includes("MERGE COMMIT"));
});

test("the DB lane says why a green pull request did not answer for the branch", () => {
  const text = message({
    lane: "db-integration",
    workflowName: "Credit Finance DB Integration",
    branch: "develop",
  });
  assert.ok(text.includes("merge of head and base"));
  assert.equal(text.includes("MERGE COMMIT"), false);
});

test("every lane has consequence text, and no lane is a bare event name", () => {
  assert.deepEqual(LANE_KEYS, ["back-merge", "db-integration"]);
  for (const lane of LANE_KEYS) {
    assert.ok(LANE_CONSEQUENCES[lane].length > 80, lane);
  }
});

test("missing fields degrade rather than print undefined", () => {
  const text = buildReleaseLaneFailureMessage({ lane: "back-merge" });
  assert.equal(text.includes("undefined"), false);
  assert.ok(text.includes("A release lane"));
  assert.ok(text.includes("an unknown branch"));
});
