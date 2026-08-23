import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
    checkDryRunBinding,
    decideSoleApproverEligibility,
    DRY_RUN_BINDING_MAX_AGE_MS,
    SOLE_APPROVER_ACTIONS,
} from "../lib/adminSoleApproverCore.ts";

/**
 * The single-administrator exception to two-person approval.
 *
 * `canReviewAdminApproval()` requires a reviewer who is not the requester,
 * which left a one-person organisation unable to run
 * `retention.cleanup.execute` at all -- recorded by the `f3974ef` and
 * `4380bc1` staging rounds. These tests are mostly about the ways the
 * exception must *not* open: another action, a second administrator, someone
 * else's preview, an old one, one that something has superseded.
 */

const eligibility = (over = {}) =>
    decideSoleApproverEligibility({
        action: "retention.cleanup.execute",
        eligibleApproverIdentities: ["ops@example.invalid"],
        requesterIdentity: "ops@example.invalid",
        ...over,
    });

test("only the named action can reach this path", () => {
    assert.deepEqual([...SOLE_APPROVER_ACTIONS], ["retention.cleanup.execute"]);
    // The actions where no schedule performs the equivalent deletion on its
    // own, and the second reviewer is therefore the only control there is.
    for (const action of ["user.delete", "refund.issue", "user.plan_adjust"]) {
        assert.deepEqual(eligibility({ action }), {
            allowed: false,
            reason: "action_not_eligible",
        });
    }
});

test("a second eligible administrator closes the path", () => {
    // Condition 6. Nothing to migrate and no flag to remember to clear: the
    // list is recomputed from configuration on every request.
    assert.deepEqual(
        eligibility({
            eligibleApproverIdentities: [
                "ops@example.invalid",
                "owner@example.invalid",
            ],
        }),
        { allowed: false, reason: "multiple_eligible_approvers" }
    );
});

test("one administrator listed twice is still one administrator", () => {
    // A single account can appear under both ADMIN_EMAILS and the ops role
    // list. Counting rows instead of identities would close the path on the
    // one organisation it exists for.
    const decision = eligibility({
        eligibleApproverIdentities: ["Ops@Example.invalid", "ops@example.invalid "],
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.approverIdentity, "ops@example.invalid");
});

test("no eligible administrator is refused, not treated as one", () => {
    assert.deepEqual(eligibility({ eligibleApproverIdentities: [] }), {
        allowed: false,
        reason: "no_eligible_approver",
    });
});

test("the requester must be that administrator", () => {
    for (const requesterIdentity of [null, undefined, "", "other@example.invalid"]) {
        assert.deepEqual(eligibility({ requesterIdentity }), {
            allowed: false,
            reason: "requester_is_not_the_sole_approver",
        });
    }
});

const NOW = new Date("2026-08-23T05:00:00.000Z");

const binding = (over = {}) => {
    const { latestRun: runOver, ...rest } = over;
    return checkDryRunBinding({
        submittedRunId: "run_1",
        submittedDigest: "a".repeat(64),
        requesterId: "admin_1",
        now: NOW,
        latestRun:
            runOver === null
                ? null
                : {
                      id: "run_1",
                      mode: "dry-run",
                      digest: "a".repeat(64),
                      createdAt: new Date(NOW.getTime() - 60_000),
                      createdById: "admin_1",
                      ...(runOver || {}),
                  },
        ...rest,
    });
};

test("a preview the operator actually saw binds the execution", () => {
    assert.deepEqual(binding(), { bound: true });
});

test("executing without running a preview is refused, not passed along", () => {
    // With one administrator this is the only path, so falling through would
    // land on an approval nobody can grant -- the state this exception exists
    // to end.
    for (const missing of [{ submittedRunId: "" }, { submittedDigest: "" }]) {
        assert.deepEqual(binding(missing), {
            bound: false,
            reason: "preview_missing",
        });
    }
});

test("the approval payload hash does not move when the preview does", () => {
    // The two-person retry, after the second administrator approves, carries
    // whatever dry run is current by then. Hashing the binding with it would
    // make every retry look like a new request and consume no approval.
    const route = readFileSync(
        "app/api/admin/maintenance/cleanup/route.ts",
        "utf8"
    );
    assert.match(
        route,
        /payload: \{ mode: body\.mode, confirmText: body\.confirmText \}/
    );
    assert.doesNotMatch(route, /payload: body,/);
});

test("with no retention run at all there is nothing to confirm", () => {
    assert.deepEqual(binding({ latestRun: null }), {
        bound: false,
        reason: "preview_missing",
    });
});

test("a superseded preview is named as superseded, not as a bad digest", () => {
    // The submitted id may well exist; what is wrong is that it is no longer
    // the newest, and saying so is what tells the operator to look again.
    assert.deepEqual(binding({ latestRun: { id: "run_2" } }), {
        bound: false,
        reason: "preview_superseded",
    });
});

test("the latest run must be a dry run", () => {
    assert.deepEqual(binding({ latestRun: { mode: "execute" } }), {
        bound: false,
        reason: "preview_not_a_dry_run",
    });
});

test("another administrator's preview does not authorise this one", () => {
    assert.deepEqual(binding({ latestRun: { createdById: "admin_2" } }), {
        bound: false,
        reason: "preview_belongs_to_another_administrator",
    });
});

test("the digest is the re-confirmation, so a wrong one refuses", () => {
    // Condition 3. The digest is of the stored result, so echoing it is only
    // possible for somebody who was shown that preview -- it cannot be
    // produced from the run id.
    assert.deepEqual(binding({ submittedDigest: "b".repeat(64) }), {
        bound: false,
        reason: "preview_digest_mismatch",
    });
});

test("a preview older than one sweep cycle has expired", () => {
    // The numbers are counts of live rows and the sweep runs every fifteen
    // minutes on its own, so an older preview can describe a queue that no
    // longer exists.
    assert.equal(DRY_RUN_BINDING_MAX_AGE_MS, 15 * 60 * 1000);
    assert.deepEqual(
        binding({
            latestRun: {
                createdAt: new Date(NOW.getTime() - DRY_RUN_BINDING_MAX_AGE_MS - 1),
            },
        }),
        { bound: false, reason: "preview_expired" }
    );
    assert.deepEqual(
        binding({
            latestRun: {
                createdAt: new Date(NOW.getTime() - DRY_RUN_BINDING_MAX_AGE_MS),
            },
        }),
        { bound: true }
    );
});

test("the execution has no parameter through which its scope could widen", () => {
    // Condition 4, and it is enforced by two facts rather than a check: the
    // operation takes no arguments and reads its cutoffs from the published
    // policy, and the request schema refuses unknown keys so one cannot be
    // added quietly.
    const maintenance = readFileSync("lib/maintenance.ts", "utf8");
    assert.match(maintenance, /export async function cleanupExpiredData\(\)/);

    const route = readFileSync(
        "app/api/admin/maintenance/cleanup/route.ts",
        "utf8"
    );
    const schema = route.slice(
        route.indexOf("const cleanupSchema"),
        route.indexOf("async function dryRunCleanup")
    );
    assert.ok(schema.length > 0);
    assert.match(schema, /\.strict\(\)/);
    // Only these five keys, so a cutoff or a target list cannot ride in.
    assert.deepEqual(
        [...schema.matchAll(/^\s{4}(\w+):/gm)].map((match) => match[1]).sort(),
        ["confirmText", "dryRunDigest", "dryRunId", "mode"]
    );

    // The call site passes the function, never a call with arguments.
    assert.match(route, /\n\s+cleanupExpiredData\n/);
    assert.doesNotMatch(route, /cleanupExpiredData\([^)]/);
});
