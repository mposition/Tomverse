import assert from "node:assert/strict";
import test from "node:test";
import { deriveImageComposerRestore } from "../lib/imageComposerRestore.ts";

// What the composer starts as when an existing image conversation is opened.
// Derived from the last comparison group -- never stored, so it cannot drift
// from the comparison it claims to describe.

const attempt = (id, attemptNumber, overrides = {}) => ({
  id,
  attemptNumber,
  preset: "standard",
  quality: "medium",
  size: "1024x1024",
  ...overrides,
});

const target = (modelId, overrides = {}) => ({
  id: `target-${modelId}`,
  modelId,
  currentGenerationId: `${modelId}-1`,
  generations: [attempt(`${modelId}-1`, 1)],
  ...overrides,
});

test("the last comparison's models and options come back", () => {
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [
      target("gpt-image-2"),
      target("grok-imagine-image-quality-20260403"),
    ],
  });
  assert.deepEqual(restore.modelIds, [
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
  ]);
  assert.equal(restore.preset, "standard");
  assert.equal(restore.quality, "medium");
  assert.equal(restore.size, "1024x1024");
  assert.equal(restore.optionsConsistent, true);
  assert.deepEqual(restore.excludedModelIds, []);
  assert.equal(restore.sourceGroupId, "group-1");
});

test("models come back in registry order, not row order", () => {
  // Selection order is recorded nowhere and carries no product meaning, so
  // taking it from row order would be arbitrary -- and unstable, since the
  // same set would come back differently depending on how rows were fetched.
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [
      target("grok-imagine-image-quality-20260403"),
      target("gpt-image-2"),
    ],
  });
  assert.deepEqual(restore.modelIds, [
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
  ]);
});

test("the target's pointer beats the highest attempt number", () => {
  // A retry appends an attempt and moves the pointer in the same transaction.
  // Reading the highest number instead would be right today and wrong the
  // moment an attempt is written before the pointer moves.
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [
      target("gpt-image-2", {
        currentGenerationId: "a-1",
        generations: [
          attempt("a-1", 1, { size: "1024x1024" }),
          attempt("a-2", 2, { size: "1536x1024" }),
        ],
      }),
    ],
  });
  assert.equal(restore.size, "1024x1024");
});

test("without a pointer the highest attempt number is the fallback", () => {
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [
      target("gpt-image-2", {
        currentGenerationId: null,
        generations: [
          attempt("a-1", 1, { size: "1024x1024" }),
          attempt("a-2", 2, { size: "1536x1024" }),
        ],
      }),
    ],
  });
  assert.equal(restore.size, "1536x1024");
});

test("targets that disagree about options restore no options at all", () => {
  // One request carries one quality and one size for the whole group, so a
  // disagreement is a bug rather than a preference. Picking one target's
  // values would present corrupt data as the user's last choice -- plausible
  // enough that nobody would question it.
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [
      target("gpt-image-2", {
        generations: [attempt("a-1", 1, { size: "1024x1024" })],
        currentGenerationId: "a-1",
      }),
      target("grok-imagine-image-quality-20260403", {
        generations: [attempt("b-1", 1, { size: "1536x1024" })],
        currentGenerationId: "b-1",
      }),
    ],
  });
  assert.equal(restore.optionsConsistent, false);
  assert.equal(restore.preset, null);
  assert.equal(restore.quality, null);
  assert.equal(restore.size, null);
  // The model combination is still the user's own choice and survives.
  assert.deepEqual(restore.modelIds, [
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
  ]);
});

test("a model held since the last comparison is excluded and reported", () => {
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [target("gpt-image-2"), target("gemini-3.1-flash-image")],
  });
  assert.deepEqual(restore.modelIds, ["gpt-image-2"]);
  assert.deepEqual(restore.excludedModelIds, ["gemini-3.1-flash-image"]);
});

test("a model with no price at the restored option is excluded too", () => {
  // Grok ships 1K square Standard only. Restoring it alongside a landscape
  // would put the composer straight into a state that refuses to submit, with
  // no stated reason -- so it is excluded and named instead.
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [
      target("gpt-image-2", {
        generations: [attempt("a-1", 1, { size: "1536x1024" })],
        currentGenerationId: "a-1",
      }),
      target("grok-imagine-image-quality-20260403", {
        generations: [attempt("b-1", 1, { size: "1536x1024" })],
        currentGenerationId: "b-1",
      }),
    ],
  });
  assert.equal(restore.size, "1536x1024");
  assert.deepEqual(restore.modelIds, ["gpt-image-2"]);
  assert.deepEqual(restore.excludedModelIds, [
    "grok-imagine-image-quality-20260403",
  ]);
});

test("the default model is the last resort, not the first", () => {
  // Only when nothing the user actually chose can be offered back.
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [target("gemini-3.1-flash-image"), target("gemini-3-pro-image")],
  });
  assert.deepEqual(restore.modelIds, ["gpt-image-2"]);
  assert.deepEqual(restore.excludedModelIds, [
    "gemini-3.1-flash-image",
    "gemini-3-pro-image",
  ]);
});

test("an unrecognised option value is treated as inconsistent, not passed through", () => {
  // A value the composer has no control for would be restored into a state no
  // click could produce, and the price lookup would refuse it.
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [
      target("gpt-image-2", {
        generations: [attempt("a-1", 1, { size: "4096x4096" })],
        currentGenerationId: "a-1",
      }),
    ],
  });
  assert.equal(restore.optionsConsistent, false);
  assert.equal(restore.size, null);
});

test("a group whose targets have no attempts yet restores its models only", () => {
  const restore = deriveImageComposerRestore({
    groupId: "group-1",
    targets: [
      target("gpt-image-2", { currentGenerationId: null, generations: [] }),
    ],
  });
  assert.deepEqual(restore.modelIds, ["gpt-image-2"]);
  assert.equal(restore.optionsConsistent, false);
  assert.equal(restore.preset, null);
});
