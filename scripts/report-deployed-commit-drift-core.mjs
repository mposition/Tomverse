// What "deployed" and "merged" being different actually means.
//
// On 2026-08-26 three pull requests merged into `main` within three minutes.
// None of them deployed. Railway's Wait for CI held each one until its commit's
// check suite finished, the suites were still running, and the deployment that
// eventually succeeded was an *older* commit whose checks had already passed.
// Production served that older commit for over an hour with nothing saying so:
// the pull requests were merged and green, the Actions list was green, and the
// only place the truth existed was the Railway dashboard.
//
// `/api/build-info` has always been able to answer "which commit is running".
// Nothing asked it on a schedule. This module is the comparison, kept pure so
// it can be tested without a network or a checkout.
//
// Two decisions are worth stating because they are what make the answer useful
// rather than merely correct.
//
// **Lag is measured from the oldest undeployed commit, not the newest.** A
// branch that has moved twice since the last deploy has been undeployed since
// the *first* of those commits, and that is how long the gap has actually
// existed. Measuring from the newest resets the clock every time someone
// merges, which is exactly when the number needs to keep climbing.
//
// **Being behind is not by itself a fault.** Between a merge and its deploy
// there is always a gap, and with Wait for CI it is as long as the suite. The
// verdict therefore reports the lag and compares it against a threshold rather
// than treating any difference as an incident -- a detector that fires on every
// merge is one nobody reads.

// A third decision, added on 2026-09-01 after five days of red nobody read.
//
// **The endpoint's answer is classified here too, not only compared here.** On
// 2026-08-27 Cloudflare Access went up in front of staging and `/api/build-info`
// started answering an unauthenticated request with a redirect to a login host.
// The script followed that redirect, received the login page's perfectly valid
// `200 text/html`, and reported "something in front of the app is answering
// instead of the app" -- true, and it names neither the gate nor the repair.
// Twenty consecutive runs said it and none of them were read.
//
// `scripts/check-edge-robots.mjs` had already solved this for its own request
// and its comment says why: following the redirect turns "the gate is on" into
// a confusing story about a 200. That knowledge did not reach this file because
// it lived in a fetch call rather than in a function anything could test. It
// lives here now, for the same reason the comparison does.

/** Deployed commit matches the branch head. */
export const IN_SYNC = "in_sync";
/** Branch head has commits the deployed commit does not. */
export const BEHIND = "behind";
/**
 * The deployed commit is not an ancestor of the head: a force-push, a revert
 * of the branch, a deploy from somewhere else, or a rollback to a commit that
 * has since left the branch. Not "behind" -- counting commits between them
 * would be meaningless -- and never silently folded into it.
 */
export const DIVERGED = "diverged";
/** Nothing to compare: the endpoint gave no commit, or it is not in the tree. */
export const UNKNOWN = "unknown";

/** Never reached the endpoint: DNS, TLS, timeout, refused. */
export const REQUEST_FAILED = "request_failed";
/**
 * Something in front of the app refused the request or sent it elsewhere.
 *
 * The name matches `isAccessGated` in scripts/check-edge-robots.mjs so the two
 * checks describe the same observation with the same word. The message it
 * produces is careful to state what was seen before what it probably means: a
 * redirect off this origin is also what a host rename looks like, and this
 * module cannot tell those apart.
 */
export const ACCESS_GATE = "access_gate";
/** A status this script has no more specific reading of. */
export const HTTP_ERROR = "http_error";
/** 2xx, but the body is not JSON. */
export const NOT_JSON = "not_json";
/**
 * JSON, but no `commitSha` in it. Previously this returned no commit and no
 * explanation, which reads in the log as an endpoint that was never asked.
 */
export const NO_COMMIT_SHA = "no_commit_sha";
/** Same-origin redirects that never arrive anywhere. */
export const REDIRECT_LOOP = "redirect_loop";

const hostOf = (url, base) => {
  try {
    return new URL(url, base).host;
  } catch {
    return null;
  }
};

/**
 * What a response to `/api/build-info` is, before its body is read.
 *
 * Redirects are split rather than followed wholesale. A 3xx that stays on this
 * origin is the app's own routing -- a host rename via `STAGING_APP_URL`, a
 * scheme upgrade -- and has to be followed or the check reports a redirect as
 * an outage. A 3xx that *leaves* the origin never reaches the app at all, and
 * following it fetches somebody else's page and grades it as though the app
 * had sent it.
 *
 * 401 and 403 are the same refusal stated directly, which is what a gate
 * answers a non-interactive request with.
 *
 * @param {object} input
 * @param {string} input.requestUrl the URL that produced this response.
 * @param {number} input.status
 * @param {string|null} input.location the `location` header, if any.
 * @returns {{reason: string|null, gateHost: string|null, followTo: string|null}}
 *   `reason` null means the response is worth reading a body from.
 */
export function classifyBuildInfoResponse({ requestUrl, status, location }) {
  const none = { reason: null, gateHost: null, followTo: null };

  if (status === 401 || status === 403) {
    return { ...none, reason: ACCESS_GATE };
  }

  if (status >= 300 && status < 400) {
    // A 3xx with nothing to follow is not a redirect, whatever it calls
    // itself. Reported as the status it is rather than guessed at.
    if (!location) return { ...none, reason: HTTP_ERROR };
    const target = hostOf(location, requestUrl);
    if (target === null) return { ...none, reason: HTTP_ERROR };
    if (target !== hostOf(requestUrl)) {
      return { ...none, reason: ACCESS_GATE, gateHost: target };
    }
    return { ...none, followTo: new URL(location, requestUrl).toString() };
  }

  if (status < 200 || status >= 300) return { ...none, reason: HTTP_ERROR };
  return none;
}

/**
 * The one line under an environment's verdict that says what to repair.
 *
 * Every branch names the status, because "could not read it" and "read it and
 * it said no" are different mornings. The gate branch additionally says where
 * the fix is, and that it is not here: `/api/build-info` is public and
 * unauthenticated by design (STG-F010), so a gate covering it is a gate that
 * needs an exemption, not a script that needs a credential.
 *
 * @returns {string|null} null when there is nothing to report.
 */
export function describeEndpointFailure({
  reason,
  status,
  contentType,
  gateHost,
  bodyPrefix,
  cause,
}) {
  switch (reason) {
    case REQUEST_FAILED:
      return `request failed — ${cause}`;
    case ACCESS_GATE:
      return (
        `HTTP ${status}${gateHost ? ` to ${gateHost}` : ""} — the request did not reach the ` +
        "app. An access gate answers an unauthenticated request this way. This endpoint is " +
        "public by design (STG-F010), so the exemption belongs in the gate " +
        "(docs/ops/staging-access-boundary.md), not in a credential here."
      );
    case HTTP_ERROR:
      return `HTTP ${status} (${contentType})`;
    case NOT_JSON:
      return (
        `HTTP ${status} (${contentType}) did not return JSON. ` +
        `The first bytes were ${JSON.stringify(bodyPrefix)} — something in front of ` +
        "the app is answering instead of the app."
      );
    case NO_COMMIT_SHA:
      return `HTTP ${status} (${contentType}) returned JSON with no commitSha field.`;
    case REDIRECT_LOOP:
      return "redirected within its own origin more times than this check will follow.";
    default:
      return null;
  }
}

/**
 * @param {object} input
 * @param {string|null} input.deployedSha commit `/api/build-info` reports
 * @param {string|null} input.headSha commit the branch points at
 * @param {boolean} input.deployedShaKnown whether the deployed commit exists in
 *   the checkout at all. A shallow clone, or a commit from another branch, is
 *   not the same fact as "no commit reported" and must not read as one.
 * @param {Array<{sha: string, committedAt: string}>} input.undeployed commits
 *   reachable from the head but not from the deployed commit, newest first.
 * @param {string} input.now ISO timestamp to measure the lag against.
 * @param {number} input.thresholdMinutes how long a gap may stand before it is
 *   worth someone's attention.
 */
export function deployedCommitDrift({
  deployedSha,
  headSha,
  deployedShaKnown,
  undeployed,
  now,
  thresholdMinutes,
}) {
  const base = {
    deployedSha: deployedSha || null,
    headSha: headSha || null,
    commitsBehind: null,
    oldestUndeployedSha: null,
    oldestUndeployedAt: null,
    lagMinutes: null,
    thresholdMinutes,
    exceedsThreshold: false,
  };

  if (!deployedSha || !headSha) {
    return { ...base, state: UNKNOWN, reason: "no commit reported" };
  }
  if (deployedSha === headSha) {
    return { ...base, state: IN_SYNC, commitsBehind: 0, lagMinutes: 0 };
  }
  if (!deployedShaKnown) {
    // Said separately from "diverged" on purpose. A commit this checkout has
    // never seen is a fact about the checkout; concluding the branch diverged
    // from it would be an assertion nothing here can support.
    return {
      ...base,
      state: UNKNOWN,
      reason: "the deployed commit is not in this checkout",
    };
  }
  if (undeployed.length === 0) {
    return { ...base, state: DIVERGED, reason: "the deployed commit is not an ancestor of the head" };
  }

  const oldest = undeployed[undeployed.length - 1];
  const lagMs = Date.parse(now) - Date.parse(oldest.committedAt);
  // A commit dated in the future -- a wrong clock on whatever wrote it -- must
  // not produce a negative lag that reads as "deployed early".
  const lagMinutes = Math.max(0, Math.round(lagMs / 60000));
  return {
    ...base,
    state: BEHIND,
    commitsBehind: undeployed.length,
    oldestUndeployedSha: oldest.sha,
    oldestUndeployedAt: oldest.committedAt,
    lagMinutes,
    exceedsThreshold: lagMinutes > thresholdMinutes,
  };
}

/** One line an operator can act on, or ignore, without opening a dashboard. */
export function describeDrift(environment, drift) {
  const short = (sha) => (sha ? sha.slice(0, 8) : "unknown");
  if (drift.state === IN_SYNC) {
    return `${environment}: in sync at ${short(drift.deployedSha)}.`;
  }
  if (drift.state === UNKNOWN) {
    return `${environment}: cannot compare — ${drift.reason}.`;
  }
  if (drift.state === DIVERGED) {
    return (
      `${environment}: serving ${short(drift.deployedSha)}, which is not an ancestor of ` +
      `${short(drift.headSha)}. A rollback, a force-push, or a deploy from elsewhere.`
    );
  }
  const plural = drift.commitsBehind === 1 ? "commit" : "commits";
  return (
    `${environment}: ${drift.commitsBehind} ${plural} behind — serving ${short(drift.deployedSha)}, ` +
    `head is ${short(drift.headSha)}. The oldest undeployed commit ` +
    `(${short(drift.oldestUndeployedSha)}) has been waiting ${drift.lagMinutes} minutes` +
    `${drift.exceedsThreshold ? `, past the ${drift.thresholdMinutes}-minute threshold` : ""}.`
  );
}
