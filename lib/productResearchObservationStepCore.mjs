// What the observation step decides, with no IO of its own.
//
// The run is four pieces of IO -- a clone, an issue read, a child process and
// one POST -- and every judgement around them is here so it can be tested
// without a network, a clone or a clock. The script owns the IO and nothing
// else; a decision added there is one the tests cannot reach, which is how the
// environment allowlist went wrong twice.
//
// The failure stages this module names are the closed list in
// `productResearchObservationCore.mjs`. A stage is stored and displayed with a
// label of its own, so a new one is a schema change, not a free string.

import { OBSERVATION_ROW_LIMIT } from "./productResearchObservationCore.mjs";

/**
 * How many issue-list requests one run may make.
 *
 * The policy's structural cost ceiling (docs/policy/product-research-agent.md
 * §7). A hundred issues per page against the row limit means two pages in
 * practice; ten is the ceiling that keeps a paging bug from walking the whole
 * API, not a target.
 */
export const ISSUE_FETCH_MAX_REQUESTS = 10;

/** Issues asked for per request. The API's maximum, so fewer requests. */
export const ISSUE_FETCH_PER_PAGE = 100;

/**
 * The most issue JSON one run will hold.
 *
 * Counted on the bytes the run keeps -- the fields it hands to the report --
 * rather than on a row count, because the row count is the thing the body gets
 * to claim. What arrived over the wire is a separate bound
 * (`ISSUE_RECEIVED_MAX_BYTES`): a cap applied after parsing has not bounded
 * memory. Over either one the run is refused whole, because a truncated
 * observation is a wrong one and the policy forbids carrying part of a run.
 */
export const ISSUE_INPUT_MAX_BYTES = 100_000;

/**
 * The fields the report needs. Everything else is dropped before it is held.
 *
 * Two, because two is what the report reads: `scripts/report-issue-backlog.mjs`
 * maps its input to `{ number, title }` and discards the rest. The first
 * version of this also held `body` and `labels`, and a run against the real
 * backlog made the cost visible -- eleven open issues came to 52,769 bytes,
 * over half of `ISSUE_INPUT_MAX_BYTES`, which would have refused an ordinary
 * backlog of twenty-five as `issue_input_too_large` and made the 200-row limit
 * unreachable. It is also less of the user's text held for no reason: an issue
 * body is external content, and the policy stores no issue field but the title.
 */
const ISSUE_FIELDS = ["number", "title"];

/**
 * The repository the run observes.
 *
 * The same name the IaC gives the services' source (`.railway/agent-runners.ts`,
 * `AGENT_RAILWAY_REPOSITORY`), and tests/agentRunnerIac.test.mjs holds the two
 * equal: a run that cloned a different repository would answer for a backlog
 * that is not this product's while looking exactly like a correct run.
 */
export const OBSERVED_REPOSITORY = "mposition/Tomverse";

/**
 * How the report child is started.
 *
 * Node's own type stripping, not `tsx`. The report imports `lib/modelPricing.ts`,
 * and `tsx` is a devDependency -- a deployed image built with `NODE_ENV=production`
 * has no `tsx`, so the run that depended on it would fail in the image and pass
 * everywhere else. The other agent services start the same way for the same
 * reason.
 */
export const REPORT_NODE_ARGS = ["--experimental-strip-types"];

/**
 * How long each piece of IO gets.
 *
 * Each one is its own timeout rather than one budget for the run, because the
 * run has to be able to say which step did not finish: `clone_failed` and
 * `issue_backlog_failed` send an operator to different places. The hard
 * deadline in the runner core is still what ends a hung process; these end a
 * hung child.
 */
export const STEP_TIMINGS = {
  cloneMs: 300_000,
  gitMs: 30_000,
  issueFetchMs: 20_000,
  reportMs: 180_000,
};

/** Two branch tips and two commit-presence checks. */
export const GIT_CALLS_PER_RUN = 4;

/**
 * The longest a run's IO may take if every step uses all of its time.
 *
 * Compared against the preparation deadline by a test. A per-step timeout that
 * individually looks generous can add up past the deadline, and then the
 * watchdog ends the run instead of the step naming itself -- the failure stage
 * would be `timeout` for something that had a stage of its own.
 */
export const worstCaseStepMs = (timings = STEP_TIMINGS) =>
  timings.cloneMs +
  GIT_CALLS_PER_RUN * timings.gitMs +
  ISSUE_FETCH_MAX_REQUESTS * timings.issueFetchMs +
  timings.reportMs;

/**
 * The most the report child may print.
 *
 * The report is richer than the payload built from it -- it carries the probe
 * sentences and the per-branch detail the payload drops -- so this is not the
 * submission ceiling. A child that printed more than this is a run that cannot
 * read its own report, which is `issue_backlog_failed` rather than a truncated
 * read.
 */
export const REPORT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;


/**
 * Which stage a failed child process belongs to.
 *
 * A child killed at its deadline is `timeout`; one that ran and refused keeps
 * the stage of the step it was doing. The two are different facts about the
 * run.
 *
 * `timedOut` and `overflowed` are the two facts here. The caller set the
 * deadline and the cap, so it knows which happened; from outside, one kill
 * looks like another. The remaining two are readings kept for what they still
 * catch: a `signal` is a child killed by something other than this run, and
 * `ETIMEDOUT` is how `spawnSync` used to report a deadline. "No status" is
 * deliberately not one of them -- a missing binary arrives that way, and
 * reading it as a timeout would report a deadline for an image that simply
 * has no `git`.
 */
export const childFailureStage = ({ signal, error, timedOut, overflowed }, stage) => {
  if (timedOut) return "timeout";
  if (error?.code === "ETIMEDOUT") return "timeout";
  // A child killed for printing more than the run will read is not a child that
  // ran out of time. It is checked before the signal, because stopping it is
  // what produced the signal.
  if (overflowed) return stage;
  if (signal) return "timeout";
  return stage;
};

/**
 * The bare partial clone the run reads its commits from.
 *
 * No credential: the target repository is public, so the fetch is anonymous and
 * the read-only token exists for the REST rate limit rather than for access
 * (docs/policy/product-research-agent.md §3). `--filter=blob:none` fetches the
 * commits and trees now and the blobs the judgement names later, `--no-tags`
 * leaves the tag namespace alone, and `--bare` writes no working tree.
 */
export const cloneArgv = (repository, directory) => [
  "clone",
  "--bare",
  "--filter=blob:none",
  "--no-tags",
  `https://github.com/${repository}.git`,
  directory,
];

/** Whether a commit the run was told to read is in the clone. */
export const commitPresentArgv = (sha) => ["cat-file", "-e", `${sha}^{commit}`];

/** The tip of a release branch, as the clone sees it. */
export const branchTipArgv = (branch) => ["rev-parse", `refs/heads/${branch}`];

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** A branch tip, or a problem naming which branch could not be read. */
export const readBranchTip = (branch, output) => {
  const sha = String(output ?? "").trim();
  if (!SHA_PATTERN.test(sha)) {
    // Named rather than generic: "clone failed" and "that clone has no `main`"
    // send an operator to different places.
    return { problem: `${branch} has no readable tip in the clone` };
  }
  return { sha };
};

/**
 * One page of the issue list.
 *
 * Open issues only, and `pulls` are excluded by the caller reading the
 * `pull_request` key -- GitHub's issue list returns pull requests too, and a
 * pull request is not backlog.
 */
export const issuesUrl = (repository, page) =>
  `https://api.github.com/repos/${repository}/issues` +
  `?state=open&per_page=${ISSUE_FETCH_PER_PAGE}&page=${page}`;

/** Headers for an issue read. The token raises the rate limit; it grants no access. */
export const issuesHeaders = (token) => ({
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  authorization: `Bearer ${token}`,
  "user-agent": "tomverse-product-research-observation",
});

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Adds one page to what the run has, or refuses.
 *
 * Three refusals, each its own stage: a page that is not a list of issues is
 * `issue_fetch_failed`, more bytes than the run will hold is
 * `issue_input_too_large`, and more issues than a row can be made for is
 * `row_count_exceeded`. None of them truncates -- the policy's rule is that a
 * run that cannot carry everything carries nothing.
 */
export const admitIssuePage = (page, held, { bytes = 0 } = {}) => {
  if (!Array.isArray(page)) {
    return { stage: "issue_fetch_failed", detail: "a page is not a list" };
  }

  for (const entry of page) {
    // Refused rather than skipped. An entry this module cannot read is a page
    // it does not understand, and dropping it would report a backlog smaller
    // than the real one while looking exactly like a correct read.
    if (!isPlainObject(entry)) {
      return { stage: "issue_fetch_failed", detail: "a page entry is not an object" };
    }
  }

  // Pull requests come back from the issue list and are not backlog.
  const issues = page.filter((entry) => !entry.pull_request);
  for (const issue of issues) {
    if (typeof issue.number !== "number" || typeof issue.title !== "string") {
      return { stage: "issue_fetch_failed", detail: "an issue has no number or title" };
    }
  }

  const kept = issues.map((issue) =>
    Object.fromEntries(ISSUE_FIELDS.filter((field) => field in issue).map((f) => [f, issue[f]])),
  );
  const next = [...held, ...kept];

  // Measured on what will be written for the report, which is what this cap is
  // about: the bytes this run holds and hands to a child process. What arrived
  // over the wire is bounded separately, by `admitReceivedBytes()`.
  const heldBytes = bytes + Buffer.byteLength(JSON.stringify(kept), "utf8");
  if (heldBytes > ISSUE_INPUT_MAX_BYTES) {
    return { stage: "issue_input_too_large", detail: `${heldBytes} bytes held` };
  }
  if (next.length > OBSERVATION_ROW_LIMIT) {
    return { stage: "row_count_exceeded", detail: `${next.length} issues` };
  }

  // A short page is the last page, judged on what the API sent and not on what
  // survived the filter above. Read from the filtered list, a single pull
  // request in a full page of a hundred would end the paging and the run would
  // submit a successful row missing every issue behind it.
  return { issues: next, bytes: heldBytes, done: page.length < ISSUE_FETCH_PER_PAGE };
};

/**
 * One response body, read no further than the caller is allowed to receive.
 *
 * Read chunk by chunk rather than with `response.json()`: that buffers and
 * parses the whole body first, so a cap checked afterwards has not bounded the
 * memory it was written to bound. This stops at the allowance and never holds
 * more than it.
 *
 * Here rather than in the script because how far to read a body is a decision,
 * and a decision in the script is one the tests cannot reach.
 *
 * It answers and never throws. A body stream rejects on its own -- the
 * connection drops after the headers arrived, or the request's own timeout
 * fires mid-body -- and an exception from here would travel past the caller's
 * failure stages and end the process with no row written at all. That is the
 * one outcome the operational contract does not allow for a failure it can
 * name: a slot that failed has to say so.
 */
export const readLimitedBody = async (response, allowance) => {
  if (!response?.body) return { problem: "the response had no body" };
  let bytes = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      // Refused as soon as it is passed, so the chunk that crossed the line is
      // the last thing read and the rest of the body is never requested.
      if (bytes > allowance) return { tooLarge: bytes };
      chunks.push(chunk);
    }
  } catch {
    // The reason is not carried out of here. A stream error's message can name
    // the request, and the request carries the token's header.
    return { problem: "the body could not be read to the end" };
  }
  return { bytes, text: Buffer.concat(chunks).toString("utf8") };
};

/**
 * How many bytes one run may receive from the issue list.
 *
 * A different cap from `ISSUE_INPUT_MAX_BYTES` and a different question: that
 * one bounds what the run keeps and writes for the child, this one bounds what
 * it reads into memory. A page of a hundred issues carries URLs, labels,
 * reactions and user objects the run drops immediately, so bounding the receive
 * at the held cap would refuse an ordinary page. Eight mebibytes is a ceiling
 * on a container with no memory to spare, not a size anything is expected to
 * reach.
 */
export const ISSUE_RECEIVED_MAX_BYTES = 8 * 1024 * 1024;

/**
 * What the run has received so far, or the stage it may not go past.
 *
 * Checked as the body arrives rather than after it: a cap applied to an
 * already-parsed response has not bounded anything, which is exactly what the
 * first version of this did.
 */
export const admitReceivedBytes = (received, added) => {
  const total = received + added;
  if (total > ISSUE_RECEIVED_MAX_BYTES) {
    return { stage: "issue_input_too_large", detail: `${total} bytes received` };
  }
  return { received: total };
};

/**
 * The report CLI's arguments, pinned to commits.
 *
 * `--branch-sha` is what makes the run reproducible: the report reads those
 * exact commits rather than whatever the branch names point at while it runs.
 */
export const reportArgv = ({ cli, repository, issuesFile, develop, main }) => [
  ...REPORT_NODE_ARGS,
  cli,
  "--json",
  "--issues-file",
  issuesFile,
  "--repository",
  repository,
  "--branch-sha",
  `develop=${develop}`,
  "--branch-sha",
  `main=${main}`,
];

/**
 * What the report produced, or the stage its failure belongs to.
 *
 * A child that exits non-zero is `issue_backlog_failed`; output that is not the
 * report's shape is `schema_invalid`. The report's own refusals print nothing on
 * stdout, which is why an empty stdout with a non-zero status is the first case.
 */
export const readReport = ({ status, stdout }) => {
  if (status !== 0) {
    return { stage: "issue_backlog_failed", detail: `the report exited ${status}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? ""));
  } catch {
    return { stage: "schema_invalid", detail: "the report did not print JSON" };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.classified)) {
    return { stage: "schema_invalid", detail: "the report has no classified list" };
  }
  return { report: parsed };
};

/**
 * The run's answer for its slot, in the shape the route admits.
 *
 * A failure carries no content at all -- not the commits it managed to read,
 * not a partial payload. The route refuses one that does, and the table's shape
 * check refuses it again; this builder simply never makes one.
 */
export const submissionBody = (outcome) =>
  outcome.failureStage === undefined
    ? {
        schemaVersion: outcome.payload.schemaVersion,
        slot: outcome.slot,
        outcome: "ok",
        developSha: outcome.developSha,
        mainSha: outcome.mainSha,
        payload: outcome.payload,
      }
    : {
        schemaVersion: outcome.schemaVersion,
        slot: outcome.slot,
        outcome: "failed",
        failureStage: outcome.failureStage,
      };

/**
 * What the route answered, checked against what was sent.
 *
 * A 2xx is not a receipt. The route answers with the row it wrote -- the slot,
 * the outcome, and **the digest it computed from what it stored** -- and its
 * own comment says why: so the run can compare and report a mismatch rather
 * than believing the row holds what it sent. Nothing was doing that
 * comparison, so a disagreement between what the runner observed and what the
 * database holds could not be noticed by anyone.
 *
 * `expected.payloadDigest` is absent for a failed slot, which stores no
 * payload and so has no digest to agree about.
 */
export const readSubmissionReceipt = (answer, expected) => {
  if (!isPlainObject(answer)) {
    return { problem: "the route answered with no receipt" };
  }
  if (answer.recorded !== true) {
    return { problem: "the route did not say it recorded a row" };
  }
  if (answer.slot !== expected.slot) {
    // A row under another slot is not this run's answer, and the slot is the
    // table's only identity.
    return { problem: "the recorded row names a different slot" };
  }
  if (answer.outcome !== expected.outcome) {
    return { problem: `the recorded row is ${String(answer.outcome)}, not ${expected.outcome}` };
  }
  if (expected.payloadDigest === undefined) {
    // A failed slot carries no payload, so there is no digest to agree about.
    return answer.payloadDigest === null || answer.payloadDigest === undefined
      ? { ok: true }
      : { problem: "a failed slot came back holding a payload digest" };
  }
  if (answer.payloadDigest !== expected.payloadDigest) {
    // Not retried and not repaired: the row exists, and a second answer for one
    // slot is worse than none. What this is for is that somebody finds out.
    return { problem: "the stored row's digest is not the digest of what was sent" };
  }
  return { ok: true };
};
