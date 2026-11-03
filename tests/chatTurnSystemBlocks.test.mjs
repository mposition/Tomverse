import assert from "node:assert/strict";
import test from "node:test";
import { buildChatTurnSystemBlocks } from "../lib/chatTurnSystemBlocks.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";
import { buildChatLocationPrompt, buildChatLocationContext } from "../lib/chatLocationPrompt.ts";
import { buildChatCurrentDatePrompt } from "../lib/chatCurrentDatePrompt.ts";
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
  imageGenerationFlagEnabled: true,
  planAllowsImageGeneration: true,
};

const build = (overrides = {}) =>
  buildChatTurnSystemBlocks({ ...base, ...overrides });

test("a chat turn that cannot search carries file, image, location, date, and search blocks", () => {
  const blocks = build();
  assert.equal(blocks.systemMessages.length, 5);
  assert.equal(blocks.systemMessages[0].role, "system");
  assert.ok(blocks.systemMessages[0].content.includes("# File generation"));
  assert.ok(blocks.systemMessages[1].content.includes("# Images"));
  assert.ok(blocks.systemMessages[2].content.includes("# Current device location"));
  assert.ok(blocks.systemMessages[3].content.includes("# Current date"));
  assert.ok(blocks.systemMessages[4].content.includes("# Current information"));
});

test("the date block states the turn's UTC date and that it is the present", () => {
  // The screenshots: "this December" answered with 2024, "today" dated to a
  // January day, both because nothing told the model what today is.
  const now = new Date("2026-10-29T13:05:00Z");
  const date = build({ now }).systemMessages[3].content;
  assert.ok(date.includes("Thursday, 2026-10-29 (UTC)"), date);
  assert.match(date, /This is the present/);
  assert.match(date, /put the year in the query/);
  // No time of day: the block must stay byte-identical for the whole day so
  // provider prefix caching survives every turn but the first after midnight.
  assert.equal(date.includes("13:05"), false);
  assert.equal(
    build({ now: new Date("2026-10-29T23:59:59Z") }).systemMessages[3].content,
    date
  );
});

test("a searching turn keeps location and date context without a search limitation", () => {
  const blocks = build({ nativeSearchEnabled: true });
  assert.equal(blocks.webSearchTurnState, "searching");
  assert.equal(blocks.webSearchCapabilityPrompt, "");
  assert.equal(blocks.systemMessages.length, 4);
  assert.ok(blocks.systemMessages.some((message) => message.content.includes("# Current date")));
  // An empty system message is a message saying nothing, priced and sent.
  assert.ok(blocks.systemMessages.every((message) => message.content.trim()));
});

test("a model that searches inside its own completion is not told it cannot", () => {
  // Perplexity attaches no tool, so `nativeSearchEnabled` is false for it. A
  // block built on that flag alone would hand a searching model a paragraph
  // saying the live web is out of reach.
  const blocks = build({ modelId: "perplexity/sonar", provider: "perplexity" });
  assert.equal(blocks.webSearchTurnState, "searching");
  assert.equal(blocks.webSearchCapabilityPrompt, "");
});

test("the priced tokens are exactly the blocks present plus the tool schema", () => {
  const blocks = build();
  const expected =
    estimateTextTokens(buildChatLocationPrompt()) +
    estimateTextTokens(buildChatCurrentDatePrompt()) +
    estimateTextTokens(blocks.artifactPlan.systemPrompt) +
    estimateTextTokens(blocks.imageCapabilityPrompt) +
    estimateTextTokens(blocks.webSearchCapabilityPrompt) +
    (blocks.artifactPlan.registerTool ? ARTIFACT_TOOL_DEFINITION_TOKENS : 0);
  assert.equal(blocks.promptTokens, expected);
});

test("the search block is priced, so the quote and the request cannot differ", () => {
  // The whole reason this builder exists: preflight quotes what the route
  // sends. A block added to the request and not to the count is the drift it
  // was written to end.
  const cannot = build();
  const can = build({ nativeSearchEnabled: true });
  assert.ok(cannot.promptTokens > can.promptTokens);
  assert.equal(
    cannot.promptTokens - can.promptTokens,
    estimateTextTokens(cannot.webSearchCapabilityPrompt)
  );
});

test("route and preflight get the same blocks and the same count from the same inputs", () => {
  // The parity this builder exists for: two call sites, one computation. If
  // they could differ, the quote and the request would differ.
  const asRoute = build();
  const asPreflight = build();
  assert.deepEqual(asRoute.systemMessages, asPreflight.systemMessages);
  assert.equal(asRoute.promptTokens, asPreflight.promptTokens);
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

test("deep research has no system blocks, and prices only a supplied ephemeral fix", () => {
  const blocks = build({ isDeepResearchTurn: true });
  assert.deepEqual(blocks.systemMessages, []);
  assert.equal(blocks.promptTokens, 0);
  const currentLocation = { latitude: 1, longitude: 2, accuracy: 150, timestamp: Date.now() };
  const located = build({ isDeepResearchTurn: true, currentLocation });
  assert.deepEqual(located.systemMessages, []);
  assert.equal(located.promptTokens, estimateTextTokens(buildChatLocationContext(currentLocation)));
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

test("an attached image does not change the image block", () => {
  // Routing an image request is the LLM judgement's job
  // (lib/chatImageIntent.ts); the capability block depends on the viewer and
  // the tools, never on the turn's text or attachments.
  const withImage = build({
    turnAttachments: [
      { handle: "att_1", name: "p.png", mediaType: "image/png", byteSize: 10 },
    ],
  });
  assert.equal(withImage.imageCapabilityPrompt, build().imageCapabilityPrompt);
  assert.equal(withImage.imageCapabilityPrompt.includes("workspace cannot edit"), false);
  assert.ok(withImage.imageCapabilityPrompt.includes("Image generation exists in this app"));
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
