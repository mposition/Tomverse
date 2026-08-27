import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import {
    ROUTER_SHADOW_FLAG,
    recordRoutingShadowRun,
} from "@/lib/routingShadow";
import { NO_WEB_SEARCH_BACKENDS } from "@/lib/webSearchBackends";
import { buildTaskProfile } from "@/lib/taskProfileCore";
import { prisma } from "@/lib/prisma";

/**
 * Shadow routing against a real database.
 *
 * What a unit test cannot show: that the row actually persists in the shape
 * the schema declares, that the flag really gates the write, and above all
 * that a failure here stays here. A routing experiment that can fail a chat
 * request is not an experiment.
 */

const ON = { [ROUTER_SHADOW_FLAG]: "true" } as Record<
    string,
    string | undefined
>;

const model = (overrides: Record<string, unknown> = {}) =>
    ({
        id: "gpt-5-6-luna",
        name: "Luna",
        apiModel: "gpt-5.6-luna",
        provider: "openai",
        icon: "",
        bestFor: "",
        minimumPlan: "Guest",
        usageClass: "standard",
        enabled: true,
        status: "available",
        contextWindowTokens: 100_000,
        ...overrides,
    }) as never;

const input = (overrides: Record<string, unknown> = {}) => ({
    traceId: `trace-${randomUUID()}`,
    subjectKey: "subject-1",
    plan: "Free" as const,
    profile: buildTaskProfile({ text: "이 정규식 디버그해 줘" }),
    userSelectedModelId: "gpt-5-6-luna",
    estimatedInputTokens: 900,
    reservedInputTokens: 1_300,
    requestOutputCapTokens: 4_000,
    models: [model(), model({ id: "deepseek-v4-flash" })],
    // No application-managed search backend reachable in this fixture. These
    // cases are about the shadow row being written, not about which models
    // could have searched, and the conservative map keeps them independent of
    // the search register.
    searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
    ...overrides,
});

const resetData = async () => {
    await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "RoutingRun" RESTART IDENTITY CASCADE`
    );
};

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("a shadow run persists the decision and what actually ran", async () => {
    const result = await recordRoutingShadowRun(input(), ON);
    assert.equal(result.recorded, true);

    const row = await prisma.routingRun.findFirstOrThrow();
    assert.equal(row.mode, "shadow");
    assert.equal(row.userSelectedModelId, "gpt-5-6-luna");
    assert.equal(row.selectedModelId, "deepseek-v4-flash");
    assert.equal(row.plan, "Free");
    assert.equal(row.eligibleCount, 2);
    assert.ok(row.taskProfileVersion.length > 0);
    assert.ok(row.selectionVersion.length > 0);
});

test("the flag is what decides whether anything is written", async () => {
    // Off is the default, and a shadow rollout that starts itself is not a
    // rollout.
    const off = await recordRoutingShadowRun(input(), {});
    assert.equal(off.recorded, false);
    assert.equal(await prisma.routingRun.count(), 0);

    await recordRoutingShadowRun(input(), ON);
    assert.equal(await prisma.routingRun.count(), 1);
});

test("a run with nothing eligible is still recorded", async () => {
    // "The Router had no answer" and "shadow routing was off" have to look
    // different in the table, or the flag's effect is unmeasurable.
    await recordRoutingShadowRun(input({ models: [] }), ON);
    const row = await prisma.routingRun.findFirstOrThrow();
    assert.equal(row.selectedModelId, null);
    assert.equal(row.selectionReason, "no_candidate");
    assert.equal(row.eligibleCount, 0);
});

test("a write failure is swallowed rather than raised", async () => {
    // The caller is a chat request. A shadow experiment that can 500 it is an
    // outage, so the only correct outcome here is `recorded: false`.
    const result = await recordRoutingShadowRun(
        // A trace id far past any column bound: the write fails, the caller
        // does not.
        input({ traceId: "t".repeat(100_000), userId: "no-such-user" }),
        ON
    );
    assert.equal(result.recorded, false);
    assert.equal(await prisma.routingRun.count(), 0);
});

test("deleting the account deletes its routing observations", async () => {
    const user = await prisma.user.create({
        data: { email: `routing-${randomUUID()}@example.test` },
    });
    await recordRoutingShadowRun(input({ userId: user.id }), ON);
    assert.equal(
        (await prisma.routingRun.findFirstOrThrow()).userId,
        user.id
    );

    // Cascade rather than SetNull. `subjectKey` and `traceId` would still name
    // the person after a null userId, so keeping the row would be a
    // half-anonymisation -- and a brand-new telemetry table has no claim on
    // surviving its subject.
    await prisma.user.delete({ where: { id: user.id } });
    assert.equal(await prisma.routingRun.count(), 0);
});

test("a guest run is untouched by any account deletion", async () => {
    // A guest row has no account to cascade from, so the nullable link must
    // not take it with someone else's deletion.
    const user = await prisma.user.create({
        data: { email: `routing-${randomUUID()}@example.test` },
    });
    await recordRoutingShadowRun(input({ plan: "Guest" }), ON);
    await prisma.user.delete({ where: { id: user.id } });
    const row = await prisma.routingRun.findFirstOrThrow();
    assert.equal(row.userId, null);
    assert.equal(row.subjectKey, "subject-1");
});

test("the stored row holds no request text", async () => {
    const secret = "myuniquesecrettoken";
    await recordRoutingShadowRun(
        input({
            profile: buildTaskProfile({
                text: `debug ${secret}`,
                attachments: [{ name: `${secret}.png`, mediaType: "image/png" }],
            }),
        }),
        ON
    );
    const row = await prisma.routingRun.findFirstOrThrow();
    assert.ok(!JSON.stringify(row).includes(secret));
});
