import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Which sweep each knowledge arm rides on.
 *
 * §14.2 says knowledge follows the image asset pattern -- DB-first tombstone
 * plus the fifteen-minute maintenance sweep. It followed only the tombstone
 * half for a while: the drain sat on the daily `cleanupExpiredData()`, so a
 * deleted file kept its bytes for up to twenty-four hours and an extraction
 * that died stayed dead for the same, against a ten-minute staleness
 * threshold that only means something on a much shorter cadence.
 *
 * Nothing caught it, because nothing said where these belong. Two staging
 * rounds and a Cloudflare console did
 * (`.github/audits/knowledge-sweep-cadence-2026-08-23.md`).
 *
 * These are source assertions rather than behavioural ones on purpose. What
 * went wrong was not a function returning the wrong answer -- every function
 * here works -- it was one of them being called from the wrong job, and the
 * only thing that can see that is which file names which.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const FIFTEEN_MINUTE_ROUTE =
    "app/api/internal/maintenance/credit-reservations/route.ts";
const DAILY_JOB = "lib/maintenance.ts";
const LIFECYCLE = "lib/assistantKnowledgeLifecycle.ts";

test("the fifteen-minute route drains knowledge tombstones", () => {
    const route = read(FIFTEEN_MINUTE_ROUTE);
    // The call, not the import. A first version of this matched the name
    // anywhere in the file and passed with the call deleted, because the
    // import line still said it.
    assert.match(
        route,
        /await runKnowledgeMaintenanceQuietly\(/,
        `${FIFTEEN_MINUTE_ROUTE} does not run the knowledge sweep. A deletion that ` +
            `committed in the database has to reach object storage on the cadence ` +
            `§14.2 promises, not once a day.`
    );
});

test("the fifteen-minute arm reclaims stalled extractions", () => {
    // A ten-minute staleness threshold and a daily reclaim cannot both be
    // right. The threshold is the one that describes the intent.
    const lifecycle = read(LIFECYCLE);
    assert.match(
        lifecycle,
        /await processPendingKnowledgeFiles\(/,
        `${LIFECYCLE} does not reclaim stalled processing. KNOWLEDGE_PROCESSING_STALE_MS ` +
            `is ten minutes; a file stuck in "processing" should not wait a day for it.`
    );
});

test("the bucket listing stays on the daily job", () => {
    // The expensive arm, and the one nobody is waiting on: it answers "is
    // there an object no row ever claimed", which is not a user's deletion.
    const route = read(FIFTEEN_MINUTE_ROUTE);
    const lifecycle = read(LIFECYCLE);
    const quietArm = lifecycle.slice(
        lifecycle.indexOf("runKnowledgeMaintenanceQuietly")
    );
    assert.doesNotMatch(
        route,
        /sweepAbandonedKnowledgeObjects/,
        `${FIFTEEN_MINUTE_ROUTE} lists the bucket. That arm is a prefix scan and ` +
            `belongs on the daily job.`
    );
    assert.doesNotMatch(
        quietArm,
        /sweepAbandonedKnowledgeObjects\(/,
        `runKnowledgeMaintenanceQuietly() lists the bucket. Same reason.`
    );
    assert.match(
        read(DAILY_JOB),
        /sweepAbandonedKnowledgeObjects\(/,
        `${DAILY_JOB} no longer sweeps abandoned objects, so nothing does.`
    );
});

test("the daily job keeps its own drain as a safety net", () => {
    // Both jobs draining the same queue is safe -- the tombstone is unique by
    // key and the drain marks completion -- and it means one job being down
    // does not strand bytes indefinitely.
    assert.match(
        read(DAILY_JOB),
        /drainKnowledgeCleanupQueue\(/,
        `${DAILY_JOB} dropped its drain. Keep it: it is the idempotent net under ` +
            `the fifteen-minute arm, not a duplicate to tidy away.`
    );
});

test("the quiet arm cannot fail its host job", () => {
    const lifecycle = read(LIFECYCLE);
    const quietArm = lifecycle.slice(
        lifecycle.indexOf("export const runKnowledgeMaintenanceQuietly")
    );
    assert.match(
        quietArm,
        /try \{/,
        `runKnowledgeMaintenanceQuietly() must not throw: it rides along on credit ` +
            `reconciliation, and a knowledge failure turning that run red would page ` +
            `somebody about the wrong thing.`
    );
});
