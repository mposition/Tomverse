import assert from "node:assert/strict";
import test from "node:test";

import { ARTIFACT_LIMITS } from "../lib/generatedArtifactCore.ts";
import {
  ARTIFACT_TOOL_NAMES,
  CREATE_DOCUMENT_BATCH_TOOL_NAME,
  GeneratedArtifactCollector,
} from "../lib/generatedArtifactTool.ts";
import { ArtifactToolCallTracker } from "../lib/generatedArtifactTurnTracker.ts";

/**
 * What the collector records for a file the answer began and never finished.
 *
 * docs/policy/generated-artifacts.md sections 1, 5 and 9. Nothing here reaches
 * object storage: a `turn_incomplete` artifact has no bytes by definition, so
 * these run in the unit suite rather than beside the storage-mocked collector
 * contract.
 *
 * The rule being pinned is the domain's first one -- if the app did not make
 * the file, it says so. A turn that promised a web page and was cut off owes
 * the user a card, and it owes them exactly one.
 */

const collector = (overrides = {}) =>
  new GeneratedArtifactCollector({
    mode: "generate",
    userId: "user_1",
    conversationId: "conv_1",
    modelId: "claude-haiku-4-5",
    traceId: "trace_1",
    ...overrides,
  });

/** The tracker's own output shape, so the two are exercised together. */
const abandoned = (...toolNames) => {
  const tracker = new ArtifactToolCallTracker([
    ...Object.values(ARTIFACT_TOOL_NAMES),
    CREATE_DOCUMENT_BATCH_TOOL_NAME,
  ]);
  toolNames.forEach((toolName, index) => {
    tracker.noteChunk({
      type: "tool-input-start",
      toolCallId: `call_${index + 1}`,
      toolName,
    });
  });
  return tracker.abandonedCalls();
};

/* -------------------------------------------------------------------------- */
/* The card a truncated turn draws                                              */
/* -------------------------------------------------------------------------- */

test("a text-file call that never ran becomes one turn_incomplete card", () => {
  const turn = collector();
  assert.equal(turn.recordIncompleteToolCalls(abandoned("create_text_file")), 1);

  const artifacts = turn.toStreamArtifacts();
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].status, "failed");
  assert.equal(artifacts[0].failureCode, "turn_incomplete");
  // `blocked` is the guest state and has a sign-in call to action. A truncated
  // answer is not that: it has a retry.
  assert.notEqual(artifacts[0].status, "blocked");
});

test("the card is labelled from the tool's kind, never from the partial input", () => {
  // A truncated call has no admitted format and no filename -- the model was
  // still writing them. The fallback descriptor is what the card says, and it
  // is the same one every other unadmitted call already uses.
  const cases = [
    [ARTIFACT_TOOL_NAMES.spreadsheet, "xlsx"],
    [ARTIFACT_TOOL_NAMES.document, "docx"],
    [ARTIFACT_TOOL_NAMES.presentation, "pptx"],
    [ARTIFACT_TOOL_NAMES.text, "txt"],
    [ARTIFACT_TOOL_NAMES.archive, "zip"],
    [CREATE_DOCUMENT_BATCH_TOOL_NAME, "zip"],
  ];
  for (const [toolName, format] of cases) {
    const turn = collector();
    turn.recordIncompleteToolCalls(abandoned(toolName));
    const [artifact] = turn.toStreamArtifacts();
    assert.equal(artifact.format, format, toolName);
    assert.equal(artifact.filename, `generated.${format}`, toolName);
    assert.equal(artifact.byteSize, 0, toolName);
  }
});

test("the artifact is attributed to the model that was answering", () => {
  const turn = collector({ modelId: "gpt-5-6-luna" });
  turn.recordIncompleteToolCalls(abandoned("create_text_file"));
  assert.equal(turn.toStreamArtifacts()[0].modelId, "gpt-5-6-luna");

  // And to whichever model actually answered, if a fallback replaced it.
  const swapped = collector({ modelId: "gpt-5-6-luna" });
  swapped.setModelId("claude-sonnet-5");
  swapped.recordIncompleteToolCalls(abandoned("create_text_file"));
  assert.equal(swapped.toStreamArtifacts()[0].modelId, "claude-sonnet-5");
});

test("the turn counts as having called a tool, so no partial call is replayed", () => {
  // `wasInvoked` gates whether the provider's response messages are stored for
  // reasoning replay. A truncated turn's messages carry a `tool_use` the
  // provider never finished writing, and replaying one is a request the
  // provider rejects outright.
  const turn = collector();
  assert.equal(turn.wasInvoked, false);
  turn.recordIncompleteToolCalls(abandoned("create_text_file"));
  assert.equal(turn.wasInvoked, true);
});

/* -------------------------------------------------------------------------- */
/* What it must not do                                                          */
/* -------------------------------------------------------------------------- */

test("no abandoned call means no artifact at all", () => {
  // The ordinary length-truncated answer: long prose, no file requested. It
  // keeps the generic incomplete notice and gets no card.
  const turn = collector();
  assert.equal(turn.recordIncompleteToolCalls([]), 0);
  assert.equal(turn.isEmpty, true);
  assert.equal(turn.wasInvoked, false);
  assert.deepEqual(turn.toStreamArtifacts(), []);
});

test("a native search name records nothing, even if one reaches this far", () => {
  const turn = collector();
  assert.equal(
    turn.recordIncompleteToolCalls([
      { toolCallId: "call_1", toolName: "web_search" },
      { toolCallId: "call_2", toolName: "google_search" },
    ]),
    0
  );
  assert.equal(turn.isEmpty, true);
  assert.equal(turn.wasInvoked, false);
});

test("a call that already produced a failure keeps its own single card", async () => {
  // The tracker removes every executed call before this is reached, so the
  // duplicate cannot arise there. Asserted from the collector's side too,
  // because the two together are what the user sees: one call, one card, with
  // the reason the call actually failed for.
  const turn = collector();
  await turn.run("text", { filename: "report.json", format: "json", content: "{" });
  const afterRun = turn.toStreamArtifacts();
  assert.equal(afterRun.length, 1);
  assert.equal(afterRun[0].failureCode, "spec_rejected");

  turn.recordIncompleteToolCalls([]);
  const afterIncomplete = turn.toStreamArtifacts();
  assert.deepEqual(afterIncomplete, afterRun);
});

test("the per-answer ceiling is not raised to make room for a card", () => {
  // Three top-level files is three (policy section 13.2). A fourth abandoned
  // call is still counted as a call -- so the turn's provider messages are
  // still withheld -- but it does not draw a fourth card.
  const turn = collector();
  const recorded = turn.recordIncompleteToolCalls(
    abandoned(
      "create_text_file",
      "create_text_file",
      "create_text_file",
      "create_text_file"
    )
  );
  assert.equal(recorded, ARTIFACT_LIMITS.maxArtifactsPerMessage);
  assert.equal(
    turn.toStreamArtifacts().length,
    ARTIFACT_LIMITS.maxArtifactsPerMessage
  );
  assert.equal(turn.wasInvoked, true);
});

test("ordinals continue from the files the turn already produced", () => {
  const turn = collector();
  turn.recordIncompleteToolCalls(
    abandoned("create_spreadsheet", "create_text_file")
  );
  assert.deepEqual(
    turn.toStreamArtifacts().map((artifact) => artifact.ordinal),
    [0, 1]
  );
  // The ordinal is the message's unique key, so a persisted row can be matched
  // back to the card that is already on screen.
  assert.deepEqual(
    turn.withPersistedIds([
      { id: "row_a", ordinal: 0 },
      { id: "row_b", ordinal: 1 },
    ]).map((artifact) => artifact.id),
    ["row_a", "row_b"]
  );
});

test("the rows handed to persistence are the failed ones, with no object key", () => {
  const turn = collector();
  turn.recordIncompleteToolCalls(abandoned("create_text_file"));

  assert.deepEqual(turn.stored, []);
  assert.equal(turn.failed.length, 1);
  assert.equal(turn.failed[0].failureCode, "turn_incomplete");
  assert.equal(turn.failed[0].ordinal, 0);
  assert.equal(turn.failed[0].modelId, "claude-haiku-4-5");
  assert.equal("objectKey" in turn.failed[0], false);
});
