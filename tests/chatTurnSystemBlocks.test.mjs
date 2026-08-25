import assert from "node:assert/strict";
import test from "node:test";
import { buildChatTurnSystemBlocks } from "../lib/chatTurnSystemBlocks.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";
import {
  ARTIFACT_TOOL_DEFINITION_TOKENS,
} from "../lib/generatedArtifactToolPolicy.ts";
import {
  getInputCreditMultiplier,
  getWeightedUsageCredits,
  INPUT_CREDIT_MULTIPLIERS,
} from "../lib/models.ts";

/** A signed-in Pro turn on a model whose artifact tool is verified. */
const base = {
  modelId: "gpt-5-6-luna",
  provider: "openai",
  isDeepResearchTurn: false,
  isAuthenticated: true,
  canPersist: true,
  nativeSearchEnabled: false,
  nativeSearchForced: false,
  turnAttachments: [],
  promptText: "draw a picture of a cat",
  imageGenerationFlagEnabled: true,
  planAllowsImageGeneration: true,
};

const build = (overrides = {}) =>
  buildChatTurnSystemBlocks({ ...base, ...overrides });

test("a chat turn always carries both capability blocks", () => {
  const blocks = build();
  assert.equal(blocks.systemMessages.length, 2);
  assert.equal(blocks.systemMessages[0].role, "system");
  assert.ok(blocks.systemMessages[0].content.includes("# File generation"));
  assert.ok(blocks.systemMessages[1].content.includes("# Images"));
});

test("the priced tokens are exactly the two blocks plus the tool schema", () => {
  const blocks = build();
  const expected =
    estimateTextTokens(blocks.artifactPlan.systemPrompt) +
    estimateTextTokens(blocks.imageCapabilityPrompt) +
    (blocks.artifactPlan.registerTool ? ARTIFACT_TOOL_DEFINITION_TOKENS : 0);
  assert.equal(blocks.promptTokens, expected);
});

test("route and preflight get the same blocks and the same count from the same inputs", () => {
  // The parity this builder exists for: two call sites, one computation. If
  // they could differ, the quote and the request would differ.
  const asRoute = build();
  const asPreflight = build();
  assert.deepEqual(asRoute.systemMessages, asPreflight.systemMessages);
  assert.equal(asRoute.promptTokens, asPreflight.promptTokens);
  assert.equal(asRoute.imageIntentClass, asPreflight.imageIntentClass);
});

test("the forced-search flag only matters while native search is enabled", () => {
  // Why preflight derives `nativeSearchForced` by narrowing
  // `nativeSearchEnabled` rather than reading the mode again: with search off
  // the flag is inert, so a mis-derivation would be invisible until the day
  // search is on -- and then it would silently price a different block on each
  // side. The policy's own gate is asserted here so the derivation order in
  // both routes has something holding it in place.
  const offTrue = build({ nativeSearchEnabled: false, nativeSearchForced: true });
  const offFalse = build({ nativeSearchEnabled: false, nativeSearchForced: false });
  assert.equal(offTrue.promptTokens, offFalse.promptTokens);
  assert.equal(offTrue.artifactPlan.registerTool, true);

  const onForced = build({ nativeSearchEnabled: true, nativeSearchForced: true });
  const onUnforced = build({ nativeSearchEnabled: true, nativeSearchForced: false });
  assert.equal(onForced.artifactPlan.registerTool, false);
  assert.equal(onUnforced.artifactPlan.registerTool, true);
  assert.notEqual(onForced.promptTokens, onUnforced.promptTokens);
});

test("a deep research turn carries no blocks and costs nothing", () => {
  const blocks = build({ isDeepResearchTurn: true });
  assert.equal(blocks.systemMessages.length, 0);
  assert.equal(blocks.promptTokens, 0);
  assert.equal(blocks.artifactPlan, null);
  assert.equal(blocks.imageCapabilityPrompt, "");
});

test("an unverified model still gets an image block, and both say what they cannot do", () => {
  // The screenshot's turn: xAI has no artifact tool, so before this change the
  // model was told about files and nothing about images.
  const blocks = build({ modelId: "grok-4-5", provider: "xai" });
  assert.equal(blocks.artifactPlan.registerTool, false);
  assert.ok(blocks.imageCapabilityPrompt.includes("Never substitute a drawing"));
  assert.equal(blocks.imageCapabilityPrompt.includes("SVG"), false);
});

test("the flag being off keeps the workspace out of the block", () => {
  const blocks = build({ imageGenerationFlagEnabled: false });
  assert.equal(blocks.imageCapabilityPrompt.includes("Image generation exists"), false);
  assert.equal(
    blocks.imageCapabilityPrompt.includes("Image generation exists in this app"),
    false
  );
});

test("no viewer is told how to reach image generation, whatever their plan", () => {
  // The ladder is the control's business now. A guest and a Free account both
  // get the prohibition and nothing about sign-in or plans, because the row
  // they will actually see states its own requirement before the click.
  for (const viewer of [
    { isAuthenticated: false, canPersist: false, planAllowsImageGeneration: false },
    { planAllowsImageGeneration: false },
    {},
  ]) {
    const text = build(viewer).imageCapabilityPrompt;
    assert.ok(text.includes("never present it as an option"), JSON.stringify(viewer));
    assert.equal(text.includes("requires signing in"), false, JSON.stringify(viewer));
    assert.equal(text.includes("included only in the paid"), false, JSON.stringify(viewer));
    assert.equal(text.includes("tools menu"), false, JSON.stringify(viewer));
  }
});

test("an attached-image edit request takes the edit branch", () => {
  const blocks = build({
    promptText: "배경을 바꿔 줘",
    turnAttachments: [
      { handle: "att_1", name: "p.png", mediaType: "image/png", byteSize: 10 },
    ],
  });
  assert.equal(blocks.imageIntentClass, "edit_or_reference");
  assert.ok(blocks.imageCapabilityPrompt.includes("workspace cannot edit"));
  assert.equal(blocks.imageCapabilityPrompt.includes("Image generation exists"), false);
});

test("a question about an attached image does not take the edit branch", () => {
  const blocks = build({
    promptText: "이 사진을 설명해 줘",
    turnAttachments: [
      { handle: "att_1", name: "p.png", mediaType: "image/png", byteSize: 10 },
    ],
  });
  assert.equal(blocks.imageIntentClass, "analysis");
  assert.equal(blocks.imageCapabilityPrompt.includes("workspace cannot edit"), false);
});

/* ------------------------------------------------------------------------ */
/* What the added tokens cost the user                                       */
/* ------------------------------------------------------------------------ */

test("the credit multiplier steps above each threshold, not at it", () => {
  // Unchanged contract, pinned here because the block's cost is only material
  // at these boundaries.
  for (const { aboveTokens, multiplier } of INPUT_CREDIT_MULTIPLIERS) {
    assert.equal(getInputCreditMultiplier(aboveTokens) < multiplier, true);
    assert.equal(getInputCreditMultiplier(aboveTokens + 1), multiplier);
  }
});

test("a turn just under a threshold can cross it once the blocks are priced", () => {
  const blocks = build();
  const model = { usageClass: "premium", creditWeight: 8 };
  for (const { aboveTokens } of INPUT_CREDIT_MULTIPLIERS) {
    const justUnder = aboveTokens;
    const withBlocks = justUnder + blocks.promptTokens;
    // The point of the test is that this is a real, quantified consequence --
    // not that it is forbidden.
    assert.ok(
      getWeightedUsageCredits(model, withBlocks) >=
        getWeightedUsageCredits(model, justUnder)
    );
    assert.ok(getInputCreditMultiplier(withBlocks) > getInputCreditMultiplier(justUnder));
  }
});
