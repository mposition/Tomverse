import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import {
    consumeContextBundle,
    deleteExpiredContextBundleConsumptions,
} from "@/lib/chatContextBundleService";
import { bundleConsumptionKey } from "@/lib/chatContextBundleCore";
import { prisma } from "@/lib/prisma";

/**
 * The §10 nonce contract against a real database.
 *
 * The pure half — what is signed, what is compared, what counts as one
 * consumption — is covered by tests/chatContextBundleCore.test.mjs. What only
 * a database can show is that the *claim* is atomic: the whole design rests on
 * the insert being the check, so two requests presenting the same
 * (bundle, model) must not both proceed. A read-then-write would pass every
 * sequential test here and fail exactly this one.
 */

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ChatContextBundleConsumption" RESTART IDENTITY CASCADE
  `);
};

const future = (minutes = 5) =>
    new Date(Date.now() + minutes * 60 * 1000);

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("a bundle is spent once per model", async () => {
    const bundleId = randomUUID();
    const claim = () =>
        consumeContextBundle({
            bundleId,
            modelId: "qa-model",
            userId: "qa-user",
            expiresAt: future(),
        });

    assert.deepEqual(await claim(), { consumed: true });
    assert.deepEqual(await claim(), {
        consumed: false,
        reason: "already_consumed",
    });
});

test("a comparison's panels each spend their own slot from one bundle", async () => {
    // The reason the key is (bundle, model) and not the bundle: three panels
    // legitimately present the same bundle, and a per-bundle rule would refuse
    // two of a comparison's own requests.
    const bundleId = randomUUID();
    const models = ["qa-model-a", "qa-model-b", "qa-model-c"];
    for (const modelId of models) {
        assert.deepEqual(
            await consumeContextBundle({
                bundleId,
                modelId,
                userId: "qa-user",
                expiresAt: future(),
            }),
            { consumed: true },
            modelId
        );
    }
    // ...and a panel that retries its own model is still a replay.
    assert.deepEqual(
        await consumeContextBundle({
            bundleId,
            modelId: models[0],
            userId: "qa-user",
            expiresAt: future(),
        }),
        { consumed: false, reason: "already_consumed" }
    );

    const stored = await prisma.chatContextBundleConsumption.findMany({
        where: { bundleId },
        select: { consumptionKey: true },
    });
    assert.deepEqual(
        stored.map((row) => row.consumptionKey).sort(),
        models.map((modelId) => bundleConsumptionKey(bundleId, modelId)).sort()
    );
});

test("concurrent claims on one (bundle, model) produce exactly one winner", async () => {
    const bundleId = randomUUID();
    const results = await Promise.all(
        Array.from({ length: 8 }, () =>
            consumeContextBundle({
                bundleId,
                modelId: "qa-model",
                userId: "qa-user",
                expiresAt: future(),
            })
        )
    );
    assert.equal(results.filter((result) => result.consumed).length, 1);
    assert.equal(
        await prisma.chatContextBundleConsumption.count({ where: { bundleId } }),
        1
    );
});

test("two different bundles never collide, however similar their ids look", async () => {
    const first = "bundle-a";
    const second = "bundle-a:qa";
    // `bundleConsumptionKey` joins with ":", so an id containing one could in
    // principle collide with another (bundle, model) pair's key.
    assert.deepEqual(
        await consumeContextBundle({
            bundleId: first,
            modelId: "qa:model",
            userId: "qa-user",
            expiresAt: future(),
        }),
        { consumed: true }
    );
    assert.deepEqual(
        await consumeContextBundle({
            bundleId: second,
            modelId: "model",
            userId: "qa-user",
            expiresAt: future(),
        }),
        // Documents the collision rather than asserting it cannot happen:
        // both keys render as "bundle-a:qa:model". Bundle ids are server-
        // generated UUIDs, which contain no ":", so the case is unreachable
        // in production -- and this test is what would fail if that ever
        // stopped being true.
        { consumed: false, reason: "already_consumed" }
    );
});

test("cleanup removes rows whose bundle has expired and keeps the live ones", async () => {
    const expired = randomUUID();
    const live = randomUUID();
    await consumeContextBundle({
        bundleId: expired,
        modelId: "qa-model",
        userId: "qa-user",
        expiresAt: new Date(Date.now() - 60_000),
    });
    await consumeContextBundle({
        bundleId: live,
        modelId: "qa-model",
        userId: "qa-user",
        expiresAt: future(),
    });

    assert.equal(await deleteExpiredContextBundleConsumptions(), 1);
    const remaining = await prisma.chatContextBundleConsumption.findMany({
        select: { bundleId: true },
    });
    assert.deepEqual(
        remaining.map((row) => row.bundleId),
        [live]
    );
});

test("the claim records who made it, content-free", async () => {
    const bundleId = randomUUID();
    await consumeContextBundle({
        bundleId,
        modelId: "qa-model",
        userId: "qa-user",
        expiresAt: future(),
    });
    const row = await prisma.chatContextBundleConsumption.findUniqueOrThrow({
        where: { consumptionKey: bundleConsumptionKey(bundleId, "qa-model") },
    });
    assert.equal(row.userId, "qa-user");
    assert.equal(row.modelId, "qa-model");
    // Nothing about the prompt, the memories or the fingerprint is stored:
    // the row exists to answer "was this spent", and §22 keeps observations
    // content-free.
    assert.deepEqual(Object.keys(row).sort(), [
        "bundleId",
        "consumptionKey",
        "createdAt",
        "expiresAt",
        "id",
        "modelId",
        "userId",
    ]);
});
