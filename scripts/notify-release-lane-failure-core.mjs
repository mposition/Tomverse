/**
 * What to say when a release branch goes red, and whether to say it at all.
 *
 * ## The failure this exists for
 *
 * On 2026-08-25 two lanes were red on a release branch and nobody was told.
 *
 *   * `Back-merge main into develop` had failed on every push to `main` since
 *     #954. Nothing announced it, and the only visible symptom was that the
 *     `Tomverse` app service stopped deploying -- five merges reached `main`
 *     and none of them shipped, for two days.
 *   * `Credit Finance DB Integration` had been failing on `develop` since a
 *     change whose own pull request never ran that lane. Four merges passed
 *     over it before a run survived long enough to report.
 *
 * Both were discoverable by opening the Actions tab. Neither was discovered.
 *
 * ## Why the notifier must not fail the job
 *
 * It runs after a step that has already failed, so a non-zero exit here adds a
 * second red check for a reason that is not the defect, and sends whoever is
 * reading it to the notifier instead of to the failure. Delivery outcome is
 * reported in the step log and in the return value; it is never an exit code.
 *
 * ## Why silence is not an acceptable "not configured"
 *
 * A repository that believes it has alerts and has no webhook is worse off
 * than one that knows it has none: the first stops checking. So an unset
 * webhook is a stated outcome (`not_configured`), printed, and distinguishable
 * from a delivery that was attempted.
 *
 * Pure: no network, no environment reads. The wrapper does both.
 */

/**
 * In priority order. A lane-specific hook first so this traffic can be sent
 * somewhere quieter than the general ops channel without moving anything else.
 */
export const RELEASE_LANE_ALERT_WEBHOOK_ENV_NAMES = [
  "RELEASE_LANE_ALERT_SLACK_WEBHOOK_URL",
  "OPS_ALERT_SLACK_WEBHOOK_URL",
  "SLACK_WEBHOOK_URL",
];

/**
 * The branches worth waking someone for.
 *
 * A feature branch going red is the pull request's own business and is already
 * on the pull request. These two are what every other branch is measured
 * against, and what production is built from.
 */
export const ALERTED_BRANCHES = ["main", "develop"];

/**
 * What a red lane means, in the words of the person who has to act.
 *
 * Keyed by workflow so the message can say the consequence rather than the
 * event. "Back-merge failed" means nothing to a reader who has not read the
 * workflow; "main is outside develop's ancestry and the app service is
 * skipping its deployments" is the same fact with the cost attached.
 */
export const LANE_CONSEQUENCES = {
  "back-merge": [
    "main is no longer an ancestor of develop, so the next change to",
    "already-released code will conflict.",
    "This also stops production deploying: the Tomverse app service waits on",
    "the commit's check suite, and a red suite marks its deployment SKIPPED",
    "while the worker services go ahead without it.",
    "Recover by hand: start from origin/develop, merge origin/main, resolve,",
    "and merge the pull request WITH A MERGE COMMIT.",
  ].join("\n"),
  "db-integration": [
    "The credit and finance PostgreSQL scenarios are failing on a release",
    "branch. A pull request run tests the merge of head and base, so it does",
    "not answer this; until the branch is green, every pull request measured",
    "against it inherits the failure and it looks like theirs.",
  ].join("\n"),
};

export const LANE_KEYS = Object.keys(LANE_CONSEQUENCES);

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Whether this run should send, and if not, why not.
 *
 * `cancelled` is deliberately not a reason to alert. A run cancelled by
 * concurrency was superseded by a run on a newer head that contains it, so it
 * answers nothing about the branch and the newer run answers for both. That
 * does cost latency -- on 2026-08-25 a develop failure went unreported for
 * roughly ninety minutes while each run was cancelled by the next merge -- but
 * a notification that fires on cancellation would say "unknown", and an alert
 * nobody can act on is how alerts get muted.
 */
export const resolveReleaseLaneAlert = ({
  conclusion,
  branch,
  webhookUrl,
} = {}) => {
  const normalisedConclusion = trimmed(conclusion).toLowerCase();
  if (normalisedConclusion !== "failure") {
    return { send: false, reason: "not_a_failure" };
  }
  if (!ALERTED_BRANCHES.includes(trimmed(branch))) {
    return { send: false, reason: "not_a_release_branch" };
  }
  const url = trimmed(webhookUrl);
  if (!url) return { send: false, reason: "not_configured" };
  if (!url.startsWith("https://")) {
    return { send: false, reason: "webhook_not_https" };
  }
  return { send: true, reason: "send", webhookUrl: url };
};

/** The first configured webhook, by the priority above. */
export const resolveWebhookUrl = (env = {}) => {
  for (const name of RELEASE_LANE_ALERT_WEBHOOK_ENV_NAMES) {
    const value = trimmed(env[name]);
    if (value) return { name, url: value };
  }
  return { name: null, url: "" };
};

/**
 * The message.
 *
 * Deliberately plain text rather than Slack blocks: this has to survive being
 * forwarded, quoted in an issue and read on a phone lock screen, and the run
 * URL is the only thing anyone clicks.
 */
export const buildReleaseLaneFailureMessage = ({
  lane,
  workflowName,
  branch,
  commitSha,
  commitMessage,
  runUrl,
} = {}) => {
  const consequence = LANE_CONSEQUENCES[trimmed(lane)] || "";
  const shortSha = trimmed(commitSha).slice(0, 8);
  const subject = trimmed(commitMessage).split("\n")[0];
  const lines = [
    `:red_circle: ${trimmed(workflowName) || "A release lane"} failed on ${
      trimmed(branch) || "an unknown branch"
    }.`,
    "",
    shortSha ? `Commit: ${shortSha}${subject ? ` ${subject}` : ""}` : "",
    trimmed(runUrl) ? `Run: ${trimmed(runUrl)}` : "",
    "",
    consequence,
  ];
  return lines.filter((line) => line !== undefined).join("\n").trim();
};
