import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  selectionModeTransition,
  stickyStateFor,
} from "@/lib/conversationSelectionMode";

/**
 * Routing policy §5 — the conversation's selection mode and Auto's sticky
 * state are stored by the server.
 *
 * The pure half is asserted in tests/autoModelSelection.test.mjs. What only a
 * database can establish is that the invariants hold against writes the
 * application did not make: a migration, an admin console, a support script,
 * a future code path that forgets the transition helper. Each of the CHECKs
 * below exists because leaving the rule in application code means the rule
 * holds until somebody writes a row another way.
 */

const resetData = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Message", "Conversation", "ChatUsageBucket" RESTART IDENTITY CASCADE`
  );

const createUser = () =>
  prisma.user.create({
    data: { email: `selection-mode-${randomUUID()}@example.test` },
  });

const seed = (userId: string, data: Record<string, unknown> = {}) =>
  prisma.conversation.create({
    data: { userId, title: "selection mode fixture", ...data },
  });

beforeEach(resetData);
after(async () => {
  await resetData();
  await prisma.$disconnect();
});

// Expand-only, defaulted to today's behaviour: deploying this changes nobody's
// conversation.
test("a new conversation is manual and carries no sticky state", async () => {
  const user = await createUser();
  const conversation = await seed(user.id);

  assert.equal(conversation.selectionMode, "manual");
  assert.equal(conversation.routerModelId, null);
  assert.equal(conversation.routerChallengerTurns, 0);
  assert.equal(stickyStateFor(conversation), null);
});

test("an Auto conversation round-trips its model and streak", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, {
    selectionMode: "auto",
    routerModelId: "deepseek-v4-flash",
    routerChallengerTurns: 2,
  });

  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.deepEqual(stickyStateFor(stored), {
    modelId: "deepseek-v4-flash",
    turnsFavouringChallenger: 2,
  });
});

// A mode nobody enumerated would be read by every later consumer as "not
// manual", and the safe reading of an unknown mode is not something each of
// them can be trusted to get right.
test("the database refuses a mode nobody enumerated", async () => {
  const user = await createUser();
  await assert.rejects(
    seed(user.id, { selectionMode: "auto_v2" }),
    /selectionMode_check/
  );
  await assert.rejects(seed(user.id, { selectionMode: "" }), /selectionMode_check/);
});

// Sticky state belongs to Auto. On a manual row nothing would ever clear it,
// and a streak accumulated under Auto would decide the first switch after Auto
// is turned back on -- using turns the user routed by hand.
test("a manual conversation cannot hold sticky state", async () => {
  const user = await createUser();

  await assert.rejects(
    seed(user.id, { selectionMode: "manual", routerModelId: "deepseek-v4-flash" }),
    /manual_has_no_sticky_state_check/
  );
  // Model and streak together, so this row is well-formed for every other
  // constraint and only the manual rule can refuse it. A streak with no model
  // is refused too, but by `challenger_turns_check` -- covered below, and
  // asserted separately because Postgres reports whichever it reaches first.
  await assert.rejects(
    seed(user.id, {
      selectionMode: "manual",
      routerModelId: "deepseek-v4-flash",
      routerChallengerTurns: 3,
    }),
    /manual_has_no_sticky_state_check/
  );
});

test("the same rule holds on update, not just on insert", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, {
    selectionMode: "auto",
    routerModelId: "deepseek-v4-flash",
    routerChallengerTurns: 1,
  });

  // Flipping the mode alone leaves the sticky columns behind, which is exactly
  // the write the transition helper exists to prevent.
  await assert.rejects(
    prisma.conversation.update({
      where: { id: conversation.id },
      data: { selectionMode: "manual" },
    }),
    /manual_has_no_sticky_state_check/
  );
});

// The helper and the constraint have to agree, or one of them is decoration.
test("the transition helper produces a write the database accepts", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, {
    selectionMode: "auto",
    routerModelId: "deepseek-v4-flash",
    routerChallengerTurns: 2,
  });

  const transition = selectionModeTransition(conversation, "manual");
  assert.equal(transition.clearedStickyState, true);

  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: transition.patch,
  });
  assert.equal(updated.selectionMode, "manual");
  assert.equal(updated.routerModelId, null);
  assert.equal(updated.routerChallengerTurns, 0);

  // And back again, from a clean slate rather than from leftovers.
  const back = selectionModeTransition(updated, "auto");
  const reopened = await prisma.conversation.update({
    where: { id: conversation.id },
    data: back.patch,
  });
  assert.equal(reopened.selectionMode, "auto");
  assert.equal(reopened.routerModelId, null);
  assert.equal(reopened.routerChallengerTurns, 0);
});

test("a streak cannot be negative, or exist without a model to be sticky about", async () => {
  const user = await createUser();

  await assert.rejects(
    seed(user.id, {
      selectionMode: "auto",
      routerModelId: "deepseek-v4-flash",
      routerChallengerTurns: -1,
    }),
    /challenger_turns_check/
  );
  await assert.rejects(
    seed(user.id, { selectionMode: "auto", routerChallengerTurns: 2 }),
    /challenger_turns_check/
  );
});

// An Auto conversation with no model yet is the ordinary state of one that has
// not been routed since it was switched on.
test("an Auto conversation may hold no sticky state at all", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, { selectionMode: "auto" });
  assert.equal(conversation.routerModelId, null);
  assert.equal(stickyStateFor(conversation), null);
});

// Deletion beats everything: the columns hang off the conversation, so an
// account deletion takes them without needing to know they exist.
test("deleting the conversation takes its routing state with it", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, {
    selectionMode: "auto",
    routerModelId: "deepseek-v4-flash",
    routerChallengerTurns: 1,
  });

  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(
    await prisma.conversation.findUnique({ where: { id: conversation.id } }),
    null
  );
});
