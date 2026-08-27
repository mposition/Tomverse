import assert from "node:assert/strict";
import test from "node:test";

import {
    BEHIND,
    DIVERGED,
    IN_SYNC,
    UNKNOWN,
    deployedCommitDrift,
    describeDrift,
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
