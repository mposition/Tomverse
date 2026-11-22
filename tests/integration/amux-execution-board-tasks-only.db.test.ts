import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, lifecycle, queryAdapter, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Owner direction 2026-11-21: the execution board's lanes hold what runs, so
// a Story stays off them. Its Tasks' progress shows on their hierarchy line,
// and archive-all's confirmation still counts it.

Object.assign(process.env, { NODE_ENV: "test" });
const STOP = new Error("board fixture stop");

type Ids = { feature: string; task: string };

/** The shared seed's backlog Task under a Feature, moved under a new Story. */
async function storyWithTask(tx: LifecycleTx, work: (ids: Ids & { story: string }) => Promise<void>) {
  try {
    await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx), {
      afterSourceConsumed: async ({ ids }: { ids: Ids }) => {
        const story = randomUUID();
        await withoutTriggers(tx, async () => {
          await tx.$executeRaw`INSERT INTO "AmuxWorkItem"
            ("id", "title", "status", "sourceSystem", "sourceKey", "sourceVersion",
             "sourceDigest", "sourceSnapshot", "cardType", "storyKind", "parentFeatureNodeId",
             "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion",
             "v4TitleDigest", "v4TitleDigestKeyId", "v4BodyCiphertext",
             "v4BodyKeyId", "v4BodyKeyVersion", "v4BodyDigest",
             "v4BodyDigestKeyId", "v4SourceApprovalId", "updatedAt")
            VALUES (${story}, 'AMUX Story', 'backlog', 'admin-idea-v4',
              ${randomUUID().replace(/-/g, "").toUpperCase()}, 'v1', ${"a".repeat(64)},
              ${JSON.stringify({ schemaVersion: "amux-v4", ideaId: randomUUID(), approvalId: randomUUID() })}::jsonb,
              'story', 'general', ${ids.feature}, ${Buffer.from("synthetic")}, 'synthetic', 1,
              ${"b".repeat(64)}, 'synthetic', ${Buffer.from("synthetic")}, 'synthetic', 1,
              ${"b".repeat(64)}, 'synthetic', 'synthetic-approval', CURRENT_TIMESTAMP)`;
          await tx.$executeRaw`UPDATE "AmuxWorkItem" SET "parentStoryCardId" = ${story}
            WHERE "id" = ${ids.task}`;
        });
        await work({ ...ids, story });
        throw STOP;
      },
    });
  } catch (error) { if (error !== STOP) throw error; }
}

after(closeLifecycleHarness);

test("the board's lanes and counts leave a Story out and keep its Task", async () => {
  const { readAmuxExecutionBoardSnapshot } = await import("@/lib/amux/adminExecutionRead");
  const { amuxExecutionLaneWhere, AMUX_EXECUTION_LANES } =
    await import("@/lib/amux/adminExecutionViewCore");
  await lifecycle(async (tx) => storyWithTask(tx, async ({ task, story }) => {
    const board = await readAmuxExecutionBoardSnapshot();
    for (const lane of board.lanes) {
      assert.equal(lane.cards.some((card) => card.id === story), false, lane.lane);
      assert.equal(lane.cards.some((card) => card.cardType === "story"), false, lane.lane);
    }
    for (const lane of AMUX_EXECUTION_LANES) {
      const where = amuxExecutionLaneWhere(lane);
      assert.equal(await tx.amuxWorkItem.count({ where: { AND: [where, { id: story }] } }), 0, lane);
      // Each lane's count is the filtered lane, Stories never in it.
      assert.equal(board.counts[lane], await tx.amuxWorkItem.count({ where }), lane);
      assert.equal(await tx.amuxWorkItem.count({ where: { AND: [where,
        { cardType: "story" }] } }), 0, lane);
    }
    // The Task stays in its lane.
    assert.equal(await tx.amuxWorkItem.count({ where: { AND: [
      amuxExecutionLaneWhere("tomverse_backlog"), { id: task }] } }), 1);
    // An untyped (legacy) card is no Story and stays on the board.
    const legacy = randomUUID();
    await tx.$executeRaw`INSERT INTO "AmuxWorkItem" ("id", "title", "status", "updatedAt")
      VALUES (${legacy}, 'legacy probe', 'backlog', CURRENT_TIMESTAMP)`;
    assert.equal(await tx.amuxWorkItem.count({ where: { AND: [
      amuxExecutionLaneWhere("tomverse_backlog"), { id: legacy }] } }), 1);
    // Archive-all still archives Stories, and its confirmation counts them.
    assert.equal(board.activeStories,
      await tx.amuxWorkItem.count({ where: { cardType: "story", archivedAt: null } }));
    assert.ok(board.activeStories >= 1);
  }));
});

test("a Task's hierarchy line carries its Story with the Story's Task progress", async () => {
  const { readAmuxCardHierarchy } = await import("@/lib/amux/adminExecutionRead");
  await lifecycle(async (tx) => storyWithTask(tx, async ({ task, story }) => {
    const row = await tx.amuxWorkItem.findUniqueOrThrow({ where: { id: task },
      select: { id: true, cardType: true, displayKey: true, status: true, archivedAt: true,
        parentFeatureNodeId: true, parentStoryCardId: true, revision: true } });
    const steps = await readAmuxCardHierarchy(row, null);
    const storyStep = steps?.find((step) => step.level === "story");
    assert.equal(storyStep?.kind, "card");
    if (storyStep?.kind !== "card") return;
    assert.equal(storyStep.id, story);
    assert.equal(storyStep.current, false);
    assert.deepEqual(storyStep.progress, { done: 0, total: 1 });
    await withoutTriggers(tx, () => tx.$executeRaw`UPDATE "AmuxWorkItem" SET "status" = 'done'
      WHERE "id" = ${task}`);
    const done = await readAmuxCardHierarchy({ ...row, status: "done" }, null);
    const doneStory = done?.find((step) => step.level === "story");
    assert.deepEqual(doneStory?.kind === "card" ? doneStory.progress : null, { done: 1, total: 1 });
  }));
});
