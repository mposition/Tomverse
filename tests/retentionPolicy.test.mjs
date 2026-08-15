import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
    RETENTION_POLICIES,
    RETENTION_SWEEP_GRACE_DAYS,
    retentionCutoff,
    retentionOverdueCutoff,
    retentionPolicy,
} from "../lib/retentionPolicyCore.ts";

/**
 * Every retention policy the Admin Console publishes must be performed by
 * something.
 *
 * Two of the nine were not. `/admin/retention` said alert delivery logs are
 * deleted after 90 days and provider check records after 30, and counted the
 * rows past each cutoff; `cleanupExpiredData()` deleted neither table. The
 * count climbed, an operator typed RUN CLEANUP, and the number stayed where it
 * was -- with nothing on screen to distinguish "the sweep found nothing" from
 * "no sweep exists".
 *
 * That is a worse failure than a missing policy. A retention statement is the
 * kind of thing that gets quoted to a customer, and both halves of this one
 * looked complete: a sentence with a number, and a count that moved.
 */

const MAINTENANCE = readFileSync(
    fileURLToPath(new URL("../lib/maintenance.ts", import.meta.url)),
    "utf8"
);
const RETENTION_ROUTE = readFileSync(
    fileURLToPath(new URL("../app/api/admin/retention/route.ts", import.meta.url)),
    "utf8"
);

/** The step names `cleanupExpiredData` actually runs. */
const maintenanceSteps = new Set(
    [...MAINTENANCE.matchAll(/\bstep\(\s*"([a-z0-9_]+)"/g)].map((match) => match[1])
);

test("the sweep is read at all, so a passing run cannot mean an empty set", () => {
    assert.ok(
        maintenanceSteps.size >= 15,
        `only ${maintenanceSteps.size} maintenance step(s) found; the parser has stopped matching`
    );
});

test("every policy that removes or changes data names a step that runs", () => {
    const unperformed = RETENTION_POLICIES.filter(
        (policy) =>
            policy.action !== "keep" &&
            (!policy.maintenanceStep || !maintenanceSteps.has(policy.maintenanceStep))
    ).map((policy) => `${policy.key} -> ${policy.maintenanceStep ?? "(none)"}`);

    assert.deepEqual(
        unperformed,
        [],
        `${unperformed.join(", ")}: the screen publishes this policy and no ` +
            `maintenance step performs it. Add the step, or change the policy to ` +
            `say what actually happens.`
    );
});

test("a keep policy names no step, because nothing may quietly start deleting", () => {
    for (const policy of RETENTION_POLICIES.filter((entry) => entry.action === "keep")) {
        assert.equal(
            policy.maintenanceStep,
            null,
            `${policy.key} is a keep policy and must not name a sweep step`
        );
    }
});

test("the audit log is the keep policy, and says so where it is read", () => {
    // Named rather than left to the loop above: the hash chain is what makes
    // the log tamper-evident, so deleting an entry from the middle of it breaks
    // every later link. A future sweep that "tidies old audit rows" is the
    // specific mistake this pins.
    const audit = retentionPolicy("auditLogs");
    assert.equal(audit.action, "keep");
    assert.match(audit.policy, /Nothing deletes them/);
});

test("every policy the screen measures is one the policy list defines", () => {
    // The screen builds its rows from the keys it measured, so a key with no
    // policy throws at request time rather than rendering a blank sentence.
    const measured = [
        ...RETENTION_ROUTE.matchAll(/^\s{6}([a-zA-Z]+): \{ staleCount/gm),
        ...RETENTION_ROUTE.matchAll(/^\s{6}([a-zA-Z]+): \{$/gm),
    ].map((match) => match[1]);
    assert.ok(measured.length >= 5, `parsed only ${measured.length} measured key(s)`);
    for (const key of measured) {
        assert.doesNotThrow(
            () => retentionPolicy(key),
            `${key} is measured by /admin/retention with no policy behind it`
        );
    }
});

test("a window is a window, and a policy without one refuses to invent a date", () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    assert.equal(
        retentionCutoff("providerChecks", now).toISOString(),
        "2026-07-14T00:00:00.000Z"
    );
    assert.equal(
        retentionCutoff("notificationLogs", now).toISOString(),
        "2026-05-15T00:00:00.000Z"
    );
    // `requestLeases` expires per row, so there is no age to compute. Returning
    // "now" instead would delete every lease.
    assert.throws(() => retentionCutoff("requestLeases", now), /no age window/);
});

test("policy keys are unique, and each carries a sentence rather than a label", () => {
    const keys = RETENTION_POLICIES.map((policy) => policy.key);
    assert.equal(new Set(keys).size, keys.length, "duplicate policy key");
    for (const policy of RETENTION_POLICIES) {
        assert.ok(
            policy.policy.length > 20 && /[.]$/.test(policy.policy),
            `${policy.key} needs a sentence an operator can act on`
        );
    }
});

test("overdue is later than the cutoff, by the sweep's own cadence", () => {
    // The distinction this pair exists to draw. `retentionCutoff` is the age
    // the policy states and the sweep deletes at; `retentionOverdueCutoff` is
    // the age past which the sweep has demonstrably not done it.
    const now = new Date("2026-08-13T00:00:00.000Z");
    assert.equal(
        retentionCutoff("providerErrors", now).toISOString(),
        "2026-07-14T00:00:00.000Z"
    );
    assert.equal(
        retentionOverdueCutoff("providerErrors", now).toISOString(),
        "2026-07-12T00:00:00.000Z"
    );
    assert.ok(
        retentionOverdueCutoff("providerErrors", now) <
            retentionCutoff("providerErrors", now),
        "overdue must be the older date, or it would fire sooner than the policy"
    );
});

test("the grace covers more than one scheduled sweep", () => {
    // One day puts the boundary exactly where the daily cron runs, so a slow
    // run flips the alarm on and off around 03:00. The value has to clear a
    // whole sweep interval and then some, or the alarm measures the clock.
    assert.ok(
        RETENTION_SWEEP_GRACE_DAYS > 1,
        "a one-day grace lands on the sweep time itself"
    );
    // And it must stay small enough that a stopped sweep still surfaces
    // quickly. A week of silence is not a monitor.
    assert.ok(RETENTION_SWEEP_GRACE_DAYS <= 3);
});

test("the grace is a monitoring threshold and never extends a retention promise", () => {
    // The reason to be explicit: `retentionOverdueCutoff` must not become the
    // age anything deletes at, or the published "older than 30 days" sentence
    // quietly becomes 32 and the policy stops being true.
    const MONITORING_ONLY = /retentionOverdueCutoff/;
    assert.ok(
        !MONITORING_ONLY.test(MAINTENANCE),
        "the sweep must delete at the policy cutoff, not at the overdue one"
    );
    assert.ok(
        !MONITORING_ONLY.test(RETENTION_ROUTE),
        "/admin/retention counts what the policy covers, not what is late"
    );
});

test("a policy with no window has no overdue date either", () => {
    assert.throws(
        () => retentionOverdueCutoff("requestLeases", new Date()),
        /no age window/
    );
});

/**
 * Email login attempts: the first table on the unswept list to get a policy.
 *
 * It holds a raw email address and two credential HMACs per sign-in attempt,
 * including attempts for addresses with no account, and nothing had ever
 * removed a row. It reached `origin/main` that way, so this was already
 * production data rather than a future problem.
 */

const CLEANUP_ROUTE = readFileSync(
    "app/api/admin/maintenance/cleanup/route.ts",
    "utf8"
);

test("email login attempts are swept, and by the column the policy is about", () => {
    const policy = retentionPolicy("emailLoginAttempts");
    assert.equal(policy.action, "delete");
    assert.equal(policy.windowDays, 7);
    assert.equal(policy.maintenanceStep, "email_login_attempts");
    // The published sentence has to say what the query does. "older than 7
    // days" would be a different promise from "7 days after they expired".
    assert.match(policy.policy, /7 days after they expired/);

    // `expiresAt`, not `createdAt`: it is the moment the row stops being able
    // to authenticate anyone, and it is the indexed column. A `createdAt`
    // sweep would be a sequential scan of a table that grows with every login
    // attempt.
    assert.match(
        MAINTENANCE,
        /emailLoginAttempt\.deleteMany\(\{\s*where: \{ expiresAt: \{ lt: retentionCutoff\("emailLoginAttempts", now\) \} \},/
    );
});

test("the screen, the dry run and the sweep count the same rows", () => {
    // The failure this whole module was written for: /admin/retention
    // published nine policies and the sweep performed seven. An operator read
    // a number, typed RUN CLEANUP, and the number did not move.
    for (const [name, source] of [
        ["/admin/retention", RETENTION_ROUTE],
        ["the cleanup dry run", CLEANUP_ROUTE],
    ]) {
        assert.match(
            source,
            /emailLoginAttempt\.count\(/,
            `${name} counts the rows`
        );
        assert.match(
            source,
            /retentionCutoff\("emailLoginAttempts", now\)/,
            `${name} uses the published cutoff rather than a literal`
        );
        assert.ok(
            !/emailLoginAttempt\.count\(\{\s*where: \{ createdAt/.test(source),
            `${name} counts by the same column the sweep deletes by`
        );
    }
});

test("no carve-out keeps the rows of people who did sign in", () => {
    // A `consumedAt: null` filter reads like caution and does the opposite:
    // consumed rows belong to successful sign-ins, so excluding them would
    // retain the email addresses of real users and delete only the rest.
    const step = MAINTENANCE.slice(
        MAINTENANCE.indexOf('step("email_login_attempts"'),
        MAINTENANCE.indexOf('step("provider_error_events"')
    );
    assert.ok(step.length > 0, "the step is where this test thinks it is");
    assert.ok(!step.includes("consumedAt"), "consumed rows are swept too");
    assert.ok(!step.includes("invalidatedAt"), "invalidated rows are swept too");
});

test("the window is shorter than every operational log policy", () => {
    // Not a round number for its own sake. Credential hashes and raw addresses
    // should not outlive the diagnostics they sit beside, and every other
    // delete policy here is measured in tens of days.
    const others = RETENTION_POLICIES.filter(
        (entry) =>
            entry.action === "delete" &&
            entry.windowDays !== null &&
            entry.key !== "emailLoginAttempts"
    );
    assert.ok(others.length > 0);
    for (const entry of others) {
        assert.ok(
            entry.windowDays > 7,
            `${entry.key} is ${entry.windowDays} days; the credential table must not be the longest`
        );
    }
});

/**
 * Deep research jobs: a row per Perplexity async request, holding a copy of
 * the report and, when things go wrong, the error text.
 *
 * Two things were wrong with it, and only one is a retention question. The
 * table had no policy, so it grew without limit -- and it has no relation to
 * `Conversation` despite naming a `conversationId`, so no cascade reached it:
 * deleting a conversation, or an entire account, left `resultText` behind as
 * the only surviving copy of a report nothing pointed at any more.
 */

const ACCOUNT_DELETION = readFileSync("lib/accountDeletion.ts", "utf8");

test("deep research jobs are swept by the clock that covers an abandoned one", () => {
    const policy = retentionPolicy("deepResearchJobs");
    assert.equal(policy.action, "delete");
    assert.equal(policy.windowDays, 30);
    assert.equal(policy.maintenanceStep, "deep_research_jobs");
    assert.match(policy.policy, /30 days after their last update/);

    // `updatedAt`, not `completedAt`. A job nobody polls again -- the user
    // starts a deep research request and closes the tab -- never reaches a
    // terminal status and never gets a `completedAt`, and that is precisely
    // the row that accumulates. A `completedAt` sweep would cover only the
    // rows that were already finished with.
    assert.match(
        MAINTENANCE,
        /perplexityAsyncJob\.deleteMany\(\{\s*where: \{ updatedAt: \{ lt: retentionCutoff\("deepResearchJobs", now\) \} \},/
    );
    assert.ok(
        !/perplexityAsyncJob\.deleteMany[\s\S]{0,200}completedAt/.test(MAINTENANCE),
        "the sweep must not filter on completedAt"
    );
});

test("the screen and the dry run measure deep research jobs the same way", () => {
    for (const [name, source] of [
        ["/admin/retention", RETENTION_ROUTE],
        ["the cleanup dry run", CLEANUP_ROUTE],
    ]) {
        assert.match(source, /perplexityAsyncJob\.count\(/, name);
        assert.match(source, /retentionCutoff\("deepResearchJobs", now\)/, name);
    }
});

test("deleting a conversation takes its deep research jobs with it", () => {
    // No cascade reaches this table, so each delete path has to say so. The
    // retention sweep is not the answer here: the point of deleting an account
    // is that the content goes when the user says so, not thirty days later on
    // a cadence.
    for (const path of [
        "lib/accountDeletion.ts",
        "app/api/conversations/[conversationId]/route.ts",
        "app/api/conversations/route.ts",
    ]) {
        assert.match(
            readFileSync(path, "utf8"),
            /deleteDeepResearchJobsForConversations\(\s*tx,/,
            `${path} removes the jobs inside the delete transaction`
        );
    }

    // Inside the same transaction as the conversation delete, and before it.
    // A failure between the two is the orphan this exists to prevent.
    const jobs = ACCOUNT_DELETION.indexOf("deleteDeepResearchJobsForConversations");
    const conversations = ACCOUNT_DELETION.indexOf("tx.conversation.deleteMany");
    assert.ok(jobs > 0 && conversations > jobs);
});
