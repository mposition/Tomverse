import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_CARD_READ_MAX_DEPENDENCIES,
  amuxCardReadback,
  classifyAmuxCardReadRows,
  parseAmuxCardSourceKey,
} from "../lib/amux/cardReadCore.ts";

const digest = (character) => character.repeat(64);
const date = (day) => new Date(`2026-09-${String(day).padStart(2, "0")}T01:02:03.000Z`);

const row = () => ({
  id: "work-item-1",
  status: "doing",
  priority: "p1",
  archivedAt: null,
  sourceSystem: "tomverse_private_workboard",
  sourceKey: "CHAT-01",
  sourceVersion: "a".repeat(40),
  sourceDigest: digest("1"),
  sourceSnapshot: {
    sourceKey: "CHAT-01",
    sectionCode: "investment",
    detailDigest: digest("1"),
    manifestDigest: digest("2"),
    policyVersion: 2,
  },
  acceptedSourceRevision: {
    id: "revision-2",
    workItemId: "work-item-1",
    sourceVersion: "b".repeat(40),
    detailDigest: digest("3"),
    sectionCode: "investment",
    state: "accepted",
    observedAt: date(23),
    decidedAt: date(24),
  },
  dependencies: [
    {
      dependency: {
        id: "dependency-z",
        status: "todo",
        priority: "p2",
        archivedAt: null,
        sourceSystem: null,
        sourceKey: null,
      },
    },
    {
      dependency: {
        id: "dependency-a",
        status: "done",
        priority: "p0",
        archivedAt: date(20),
        sourceSystem: "tomverse_private_workboard",
        sourceKey: "PLAT-01",
      },
    },
  ],
});

test("source keys are exact canonical board keys", () => {
  assert.equal(parseAmuxCardSourceKey("CHAT-01"), "CHAT-01");
  assert.equal(parseAmuxCardSourceKey("A".repeat(64)), "A".repeat(64));
  for (const invalid of [
    null,
    "",
    "chat-01",
    " CHAT-01",
    "CHAT-01 ",
    "CHAT_01",
    "CHAT.01",
    "A".repeat(65),
  ]) {
    assert.equal(parseAmuxCardSourceKey(invalid), null, String(invalid));
  }
});

test("read-back preserves import and accepted revision semantics without inventing goal text", () => {
  const result = amuxCardReadback(row(), "CHAT-01");
  assert.ok(result);
  assert.equal(result.status, "doing");
  assert.equal(result.priority, "p1");
  assert.equal(result.archived, false);
  assert.deepEqual(result.importSource, {
    sourceVersion: "a".repeat(40),
    sourceDigest: digest("1"),
    snapshot: {
      representation: "metadata_only",
      sourceKey: "CHAT-01",
      sectionCode: "investment",
      detailDigest: digest("1"),
      manifestDigest: digest("2"),
      policyVersion: 2,
    },
  });
  assert.equal(result.acceptedSourceRevision.id, "revision-2");
  assert.equal(result.acceptedSourceRevision.detailDigest, digest("3"));
  assert.equal("parentRevisionId" in result.acceptedSourceRevision, false);
  assert.deepEqual(result.remainingGoal, {
    availability: "not_stored",
    representation: "detail_digest_only",
    sourceVersion: "b".repeat(40),
    sectionCode: "investment",
    detailDigest: digest("3"),
  });
  assert.equal("content" in result.remainingGoal, false);
  assert.deepEqual(
    result.dependencies.map((dependency) => dependency.id),
    ["dependency-z", "dependency-a"],
  );
  assert.equal(result.dependencies[1].archived, true);
});

test("untrusted or incomplete provenance fails closed instead of exposing a full snapshot", () => {
  for (const mutate of [
    (candidate) => (candidate.sourceKey = "CHAT-02"),
    (candidate) => (candidate.sourceSystem = null),
    (candidate) => (candidate.sourceSystem = "other_canonical_board"),
    (candidate) => (candidate.sourceSystem = "Invalid Source"),
    (candidate) => (candidate.sourceVersion = "not-a-commit"),
    (candidate) => (candidate.sourceDigest = "not-a-digest"),
    (candidate) => (candidate.sourceSnapshot = null),
    (candidate) => (candidate.sourceSnapshot = { ...candidate.sourceSnapshot, prose: "private" }),
    (candidate) => (candidate.sourceSnapshot.detailDigest = digest("4")),
    (candidate) => (candidate.sourceSnapshot.manifestDigest = "not-a-digest"),
    (candidate) => (candidate.acceptedSourceRevision = null),
    (candidate) => (candidate.acceptedSourceRevision.workItemId = "another-work-item"),
    (candidate) => (candidate.acceptedSourceRevision.state = "observed"),
    (candidate) => (candidate.acceptedSourceRevision.sourceVersion = "not-a-commit"),
    (candidate) => (candidate.acceptedSourceRevision.sectionCode = "unknown"),
    (candidate) => (candidate.acceptedSourceRevision.detailDigest = "not-a-digest"),
  ]) {
    const candidate = structuredClone(row());
    mutate(candidate);
    assert.equal(amuxCardReadback(candidate, "CHAT-01"), null);
  }
});

test("dependency provenance and the bounded dependency page fail closed", () => {
  for (const mutate of [
    (candidate) => (candidate.dependencies[0].dependency.sourceSystem = "Invalid Source"),
    (candidate) => (candidate.dependencies[0].dependency.sourceSystem = "source-without-key"),
    (candidate) => {
      candidate.dependencies[0].dependency.sourceSystem = "tomverse_private_workboard";
      candidate.dependencies[0].dependency.sourceKey = "bad-key";
    },
    (candidate) => {
      candidate.dependencies = Array.from(
        { length: AMUX_CARD_READ_MAX_DEPENDENCIES + 1 },
        (_, index) => ({
          dependency: {
            id: `dependency-${index}`,
            status: "todo",
            priority: "p3",
            archivedAt: null,
            sourceSystem: null,
            sourceKey: null,
          },
        }),
      );
    },
  ]) {
    const candidate = structuredClone(row());
    mutate(candidate);
    assert.equal(amuxCardReadback(candidate, "CHAT-01"), null);
  }
});

test("bounded exact matches classify missing and ambiguous rows before serialization", () => {
  assert.deepEqual(classifyAmuxCardReadRows([], "CHAT-01"), { kind: "missing" });
  assert.deepEqual(classifyAmuxCardReadRows([row(), row()], "CHAT-01"), {
    kind: "ambiguous",
  });

  const invalid = row();
  invalid.sourceKey = "CHAT-02";
  assert.deepEqual(classifyAmuxCardReadRows([invalid], "CHAT-01"), {
    kind: "invalid_provenance",
  });
  assert.equal(classifyAmuxCardReadRows([row()], "CHAT-01").kind, "found");
});
