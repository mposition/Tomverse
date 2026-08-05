import assert from "node:assert/strict";
import test from "node:test";
import {
    SOURCE_LOCK_SUSPENDED_STATUS,
    memoryIsBlockedBySourceLock,
    planSourceLockTransition,
    summarizeSourceLockImpact,
} from "../lib/memorySourceLock.ts";

/**
 * §7.1 — locking a source suspends the memories it is the last reachable
 * evidence for, and unlocking brings them back.
 *
 * The tests below are written around the two things that make this different
 * from the source-delete path: it is reversible, so the restore has to land
 * somewhere exactly right, and it is a property of the whole evidence set
 * rather than of the source that changed.
 */

const NOW = new Date("2026-08-05T00:00:00.000Z");

const memory = (overrides = {}) => ({
    id: "mem-1",
    status: "active",
    expiresAt: null,
    evidences: [{ sourceLocked: true }],
    ...overrides,
});

const locked = (count) => Array.from({ length: count }, () => ({ sourceLocked: true }));
const unlocked = (count) =>
    Array.from({ length: count }, () => ({ sourceLocked: false }));

/* ------------------------------------------------------- what counts as gone */

test("a memory is blocked only when every one of its sources is locked", () => {
    assert.equal(memoryIsBlockedBySourceLock(locked(1)), true);
    assert.equal(memoryIsBlockedBySourceLock(locked(3)), true);
    assert.equal(
        memoryIsBlockedBySourceLock([...locked(3), ...unlocked(1)]),
        false,
        "one reachable source is enough to keep the statement backed"
    );
    assert.equal(memoryIsBlockedBySourceLock(unlocked(2)), false);
});

test("a memory with no evidence at all is not blocked by a lock", () => {
    // This is the §13.1 shape -- its source was deleted and that path decided
    // what to do with it. `every` over an empty array is vacuously true, so
    // getting this wrong would have a lock somewhere else in the account
    // quietly claim it.
    assert.equal(memoryIsBlockedBySourceLock([]), false);

    const plan = planSourceLockTransition({
        memories: [memory({ evidences: [] })],
        now: NOW,
    });
    assert.deepEqual(plan.suspendIds, []);
    assert.deepEqual(plan.unchangedIds, ["mem-1"]);
});

/* --------------------------------------------------------------- suspending */

test("locking the last reachable source suspends an active memory", () => {
    const plan = planSourceLockTransition({
        memories: [memory({ evidences: locked(1) })],
        now: NOW,
    });
    assert.deepEqual(plan.suspendIds, ["mem-1"]);
    assert.deepEqual(plan.restoreIds, []);
    assert.deepEqual(plan.expireIds, []);
});

test("a memory backed by manual grounds survives locking every import", () => {
    // Manual evidence is modelled as unlocked because nothing hides it from
    // the user. If that were reversed, writing your own grounds for a memory
    // would stop protecting it the moment you locked the import it came from.
    const plan = planSourceLockTransition({
        memories: [memory({ evidences: [...locked(2), ...unlocked(1)] })],
        now: NOW,
    });
    assert.deepEqual(plan.suspendIds, []);
    assert.deepEqual(plan.unchangedIds, ["mem-1"]);
});

test("only active memories are suspended", () => {
    // §7.1 says active, and the reason it can is that the suspended status is
    // then the record of what to restore to. Suspending a candidate would make
    // the restore promote something the user never approved.
    const untouched = [
        "candidate",
        "rejected",
        "superseded",
        "expired",
        "manual_review_required",
        "suspended_by_source_delete",
        "deleted",
    ];
    for (const status of untouched) {
        const plan = planSourceLockTransition({
            memories: [memory({ status, evidences: locked(1) })],
            now: NOW,
        });
        assert.deepEqual(
            plan.suspendIds,
            [],
            `${status} must keep the status that says why it left`
        );
        assert.deepEqual(plan.unchangedIds, ["mem-1"]);
    }
});

test("a memory already suspended by the lock is not suspended again", () => {
    const plan = planSourceLockTransition({
        memories: [
            memory({ status: SOURCE_LOCK_SUSPENDED_STATUS, evidences: locked(1) }),
        ],
        now: NOW,
    });
    assert.deepEqual(plan.suspendIds, []);
    assert.deepEqual(plan.restoreIds, []);
    assert.deepEqual(plan.unchangedIds, ["mem-1"]);
});

/* ---------------------------------------------------------------- restoring */

test("unlocking a source restores the memories it was holding", () => {
    const plan = planSourceLockTransition({
        memories: [
            memory({
                status: SOURCE_LOCK_SUSPENDED_STATUS,
                evidences: unlocked(1),
            }),
        ],
        now: NOW,
    });
    assert.deepEqual(plan.restoreIds, ["mem-1"]);
    assert.deepEqual(plan.expireIds, []);
});

test("unlocking one of several locked sources is enough to restore", () => {
    const plan = planSourceLockTransition({
        memories: [
            memory({
                status: SOURCE_LOCK_SUSPENDED_STATUS,
                evidences: [...locked(2), ...unlocked(1)],
            }),
        ],
        now: NOW,
    });
    assert.deepEqual(plan.restoreIds, ["mem-1"]);
});

test("a memory suspended by a source delete is never restored by an unlock", () => {
    // Different status, different cause, and §8.3 gives that one no automatic
    // way back -- the user has to write evidence themselves.
    const plan = planSourceLockTransition({
        memories: [
            memory({
                status: "suspended_by_source_delete",
                evidences: unlocked(1),
            }),
        ],
        now: NOW,
    });
    assert.deepEqual(plan.restoreIds, []);
    assert.deepEqual(plan.unchangedIds, ["mem-1"]);
});

test("a memory that expired while suspended is expired, not restored", () => {
    // §7.1 restores "if no other blocking reason applies". Restoring this one
    // to active would put an expired memory back into retrieval until the §8.6
    // sweep next ran.
    const plan = planSourceLockTransition({
        memories: [
            memory({
                status: SOURCE_LOCK_SUSPENDED_STATUS,
                evidences: unlocked(1),
                expiresAt: new Date(NOW.getTime() - 1),
            }),
        ],
        now: NOW,
    });
    assert.deepEqual(plan.expireIds, ["mem-1"]);
    assert.deepEqual(plan.restoreIds, []);
});

test("an expiry still in the future does not block a restore", () => {
    const plan = planSourceLockTransition({
        memories: [
            memory({
                status: SOURCE_LOCK_SUSPENDED_STATUS,
                evidences: unlocked(1),
                expiresAt: new Date(NOW.getTime() + 1),
            }),
        ],
        now: NOW,
    });
    assert.deepEqual(plan.restoreIds, ["mem-1"]);
    assert.deepEqual(plan.expireIds, []);
});

/* ---------------------------------------------------------- one convergence */

test("one plan covers lock, unlock and reconciliation in the same batch", () => {
    // Lock and unlock are not two transitions with two code paths; they are one
    // convergence over whatever rows the caller hands in. The reconciliation
    // sweep hands in a mixture, so the mixture has to work.
    const plan = planSourceLockTransition({
        memories: [
            memory({ id: "to-suspend", evidences: locked(1) }),
            memory({
                id: "to-restore",
                status: SOURCE_LOCK_SUSPENDED_STATUS,
                evidences: unlocked(1),
            }),
            memory({
                id: "to-expire",
                status: SOURCE_LOCK_SUSPENDED_STATUS,
                evidences: unlocked(1),
                expiresAt: new Date(NOW.getTime() - 1000),
            }),
            memory({ id: "still-backed", evidences: unlocked(1) }),
            memory({
                id: "still-blocked",
                status: SOURCE_LOCK_SUSPENDED_STATUS,
                evidences: locked(2),
            }),
        ],
        now: NOW,
    });

    assert.deepEqual(plan.suspendIds, ["to-suspend"]);
    assert.deepEqual(plan.restoreIds, ["to-restore"]);
    assert.deepEqual(plan.expireIds, ["to-expire"]);
    assert.deepEqual(plan.unchangedIds, ["still-backed", "still-blocked"]);
});

test("the plan is idempotent: running it on its own outcome changes nothing", () => {
    const after = planSourceLockTransition({
        memories: [
            memory({ status: SOURCE_LOCK_SUSPENDED_STATUS, evidences: locked(1) }),
            memory({ id: "restored", status: "active", evidences: unlocked(1) }),
        ],
        now: NOW,
    });
    assert.deepEqual(after.suspendIds, []);
    assert.deepEqual(after.restoreIds, []);
    assert.deepEqual(after.expireIds, []);
});

/* ------------------------------------------------------------------ preview */

test("the impact summary counts every memory exactly once", () => {
    const memories = [
        memory({ id: "a", evidences: locked(1) }),
        memory({ id: "b", evidences: [...locked(1), ...unlocked(1)] }),
        memory({ id: "c", evidences: locked(3) }),
        memory({ id: "d", evidences: [] }),
    ];
    const impact = summarizeSourceLockImpact(memories);
    assert.deepEqual(impact, { blockedCount: 2, backedCount: 2 });
    assert.equal(impact.blockedCount + impact.backedCount, memories.length);
});
