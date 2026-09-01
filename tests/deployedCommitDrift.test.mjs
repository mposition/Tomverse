import assert from "node:assert/strict";
import test from "node:test";

import {
    ACCESS_GATE,
    BEHIND,
    DIVERGED,
    HTTP_ERROR,
    IN_SYNC,
    NOT_JSON,
    NO_COMMIT_SHA,
    REDIRECT_LOOP,
    REQUEST_FAILED,
    UNKNOWN,
    classifyBuildInfoResponse,
    deployedCommitDrift,
    describeDrift,
    describeEndpointFailure,
} from "../scripts/report-deployed-commit-drift-core.mjs";

const NOW = "2026-08-26T12:00:00.000Z";
const THRESHOLD = 60;

const drift = (overrides) =>
    deployedCommitDrift({
        deployedSha: "a".repeat(40),
        headSha: "b".repeat(40),
        deployedShaKnown: true,
        undeployed: [],
        now: NOW,
        thresholdMinutes: THRESHOLD,
        ...overrides,
    });

test("a matching commit is in sync and has no lag", () => {
    const result = drift({ headSha: "a".repeat(40) });
    assert.equal(result.state, IN_SYNC);
    assert.equal(result.commitsBehind, 0);
    assert.equal(result.lagMinutes, 0);
    assert.equal(result.exceedsThreshold, false);
});

test("lag is measured from the oldest undeployed commit, not the newest", () => {
    // The whole point. Three commits merged; the first has been waiting two
    // hours and the last two minutes. Measuring from the newest would reset the
    // clock on every merge -- which is exactly when the number has to keep
    // climbing, because that is what happened on 2026-08-26.
    const result = drift({
        undeployed: [
            { sha: "c".repeat(40), committedAt: "2026-08-26T11:58:00.000Z" },
            { sha: "d".repeat(40), committedAt: "2026-08-26T11:00:00.000Z" },
            { sha: "e".repeat(40), committedAt: "2026-08-26T10:00:00.000Z" },
        ],
    });
    assert.equal(result.state, BEHIND);
    assert.equal(result.commitsBehind, 3);
    assert.equal(result.lagMinutes, 120);
    assert.equal(result.oldestUndeployedSha, "e".repeat(40));
    assert.equal(result.exceedsThreshold, true);
});

test("a fresh merge is behind but not past the threshold", () => {
    // A detector that fires between every merge and its deploy is one nobody
    // reads, and with Wait for CI that gap is as long as the suite.
    const result = drift({
        undeployed: [{ sha: "c".repeat(40), committedAt: "2026-08-26T11:55:00.000Z" }],
    });
    assert.equal(result.state, BEHIND);
    assert.equal(result.lagMinutes, 5);
    assert.equal(result.exceedsThreshold, false);
});

test("the threshold is exclusive, so exactly at it is not yet past it", () => {
    const result = drift({
        undeployed: [{ sha: "c".repeat(40), committedAt: "2026-08-26T11:00:00.000Z" }],
    });
    assert.equal(result.lagMinutes, 60);
    assert.equal(result.exceedsThreshold, false);
});

test("a deployed commit that is not an ancestor is diverged, never behind", () => {
    // Counting commits between two commits that do not descend from each other
    // would be meaningless, and calling it "behind" would suggest waiting fixes
    // it. A rollback does not close on its own.
    const result = drift({ undeployed: [] });
    assert.equal(result.state, DIVERGED);
    assert.equal(result.commitsBehind, null);
});

test("no reported commit is unknown, not in sync and not diverged", () => {
    const result = drift({ deployedSha: null });
    assert.equal(result.state, UNKNOWN);
    assert.equal(result.reason, "no commit reported");
});

test("a commit this checkout has never seen is its own answer", () => {
    // A shallow clone is a fact about the checkout. Concluding the branch
    // diverged from it would be an assertion nothing here can support.
    const result = drift({ deployedShaKnown: false });
    assert.equal(result.state, UNKNOWN);
    assert.equal(result.reason, "the deployed commit is not in this checkout");
});

test("a commit dated in the future does not read as deployed early", () => {
    const result = drift({
        undeployed: [{ sha: "c".repeat(40), committedAt: "2026-08-26T13:00:00.000Z" }],
    });
    assert.equal(result.lagMinutes, 0);
    assert.equal(result.exceedsThreshold, false);
});

test("every state describes itself in one line an operator can act on", () => {
    const behind = describeDrift(
        "production",
        drift({ undeployed: [{ sha: "c".repeat(40), committedAt: "2026-08-26T09:00:00.000Z" }] })
    );
    assert.match(behind, /1 commit behind/);
    assert.match(behind, /180 minutes/);
    assert.match(behind, /past the 60-minute threshold/);

    assert.match(describeDrift("staging", drift({ headSha: "a".repeat(40) })), /in sync/);
    assert.match(describeDrift("staging", drift({ undeployed: [] })), /not an ancestor/);
    assert.match(describeDrift("staging", drift({ deployedSha: null })), /cannot compare/);
});

test("no full commit sha reaches the summary line", () => {
    // Not secret, just unreadable: a line an operator is meant to act on
    // without opening a dashboard cannot be mostly hex.
    const line = describeDrift(
        "production",
        drift({ undeployed: [{ sha: "c".repeat(40), committedAt: "2026-08-26T09:00:00.000Z" }] })
    );
    for (const sha of ["a".repeat(40), "b".repeat(40), "c".repeat(40)]) {
        assert.ok(!line.includes(sha), "the line should abbreviate every sha");
    }
});

// The endpoint's answer, classified without a network.
//
// This half of the module exists because of what the check did between
// 2026-08-27 and 2026-09-01: Cloudflare Access went up in front of staging,
// every run redirected to a login host, and the check followed the redirect and
// reported the login page's 200 as the app's own answer. It failed correctly
// and explained nothing, twenty times.

const STAGING = "https://staging.tomverse.app/api/build-info";

test("a redirect that leaves the origin is a gate, not a page to fetch", () => {
    const result = classifyBuildInfoResponse({
        requestUrl: STAGING,
        status: 302,
        location:
            "https://sparkling-rain-1619.cloudflareaccess.com/cdn-cgi/access/login/staging.tomverse.app?kid=x",
    });
    assert.equal(result.reason, ACCESS_GATE);
    assert.equal(result.gateHost, "sparkling-rain-1619.cloudflareaccess.com");
    // The one that matters: nothing downstream may follow this.
    assert.equal(result.followTo, null);
});

test("a redirect that stays on the origin is the app's own routing", () => {
    // A host rename through STAGING_APP_URL, a scheme upgrade, a trailing
    // slash. Reporting these as an outage would be a check that breaks on
    // ordinary configuration.
    const result = classifyBuildInfoResponse({
        requestUrl: STAGING,
        status: 308,
        location: "/api/build-info/",
    });
    assert.equal(result.reason, null);
    assert.equal(result.followTo, "https://staging.tomverse.app/api/build-info/");
});

test("401 and 403 are the same refusal stated without a redirect", () => {
    for (const status of [401, 403]) {
        const result = classifyBuildInfoResponse({ requestUrl: STAGING, status, location: null });
        assert.equal(result.reason, ACCESS_GATE, `${status} should read as a gate`);
        assert.equal(result.gateHost, null);
    }
});

test("a 3xx with nowhere to go is reported as its status, not guessed at", () => {
    for (const location of [null, "http://[::bad"]) {
        const result = classifyBuildInfoResponse({ requestUrl: STAGING, status: 302, location });
        assert.equal(result.reason, HTTP_ERROR);
        assert.equal(result.followTo, null);
    }
});

test("an ordinary 2xx is left alone for its body to be read", () => {
    const result = classifyBuildInfoResponse({ requestUrl: STAGING, status: 200, location: null });
    assert.deepEqual(result, { reason: null, gateHost: null, followTo: null });
});

test("a 404 is an http error and never a gate", () => {
    // The distinction the line is for: a missing route is a deploy that is
    // running the wrong code, and a gate is a deploy nobody can ask.
    assert.equal(
        classifyBuildInfoResponse({ requestUrl: STAGING, status: 404, location: null }).reason,
        HTTP_ERROR
    );
});

test("the gate line names where the fix is, and that it is not in this script", () => {
    const line = describeEndpointFailure({
        reason: ACCESS_GATE,
        status: 302,
        gateHost: "sparkling-rain-1619.cloudflareaccess.com",
    });
    assert.match(line, /302/);
    assert.match(line, /sparkling-rain-1619\.cloudflareaccess\.com/);
    assert.match(line, /did not reach the app/);
    // Without this the reader repairs the wrong thing -- reaching for a token
    // for an endpoint whose whole contract is not needing one.
    assert.match(line, /STG-F010/);
    assert.match(line, /docs\/ops\/staging-access-boundary\.md/);
});

test("the gate line still works when the refusal carried no destination", () => {
    const line = describeEndpointFailure({ reason: ACCESS_GATE, status: 403, gateHost: null });
    assert.match(line, /403/);
    assert.ok(!line.includes("undefined"), "a missing host must not print as undefined");
    assert.ok(!line.includes(" to  "), "a missing host must not leave a dangling 'to'");
});

test("JSON without a commitSha says so instead of saying nothing", () => {
    // This used to return no commit and no error line, which reads in the log
    // as an endpoint that was never asked.
    const line = describeEndpointFailure({
        reason: NO_COMMIT_SHA,
        status: 200,
        contentType: "application/json",
    });
    assert.match(line, /no commitSha/);
});

test("every failure reason produces a line, and an unknown one produces none", () => {
    // A reason with no branch would print `undefined` under an environment's
    // verdict, which is worse than the silence it replaced.
    for (const reason of [REQUEST_FAILED, ACCESS_GATE, HTTP_ERROR, NOT_JSON, NO_COMMIT_SHA, REDIRECT_LOOP]) {
        const line = describeEndpointFailure({
            reason,
            status: 500,
            contentType: "text/html",
            bodyPrefix: "<!DOCTYPE",
            cause: "socket hang up",
        });
        assert.equal(typeof line, "string", `${reason} should describe itself`);
        assert.ok(line.length > 0, `${reason} should not describe itself as nothing`);
        assert.ok(!line.includes("undefined"), `${reason} should not print undefined`);
    }
    assert.equal(describeEndpointFailure({ reason: null }), null);
});
