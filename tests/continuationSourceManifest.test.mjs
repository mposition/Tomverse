import assert from "node:assert/strict";
import test from "node:test";
import { planContinuationSeed, planRetrievedContinuationSeed, emptyContinuationSeedPlan } from "../lib/externalContinuationSeedCore.ts";
import { serializeContinuationSourcePlan, restoreContinuationSourcePlan, parseContinuationSourceManifest } from "../lib/continuationSourceManifest.ts";

const snapshot = { id: "source", conversationDigest: "snapshot-digest", digestVersion: 1, messageCount: 3 };
const attempt = { assistantMessageId: "answer", sourceUserMessageId: "question", attemptIndex: 1, actualModelId: "fallback-model", provider: "test" };
const messages = [
  { ordinal: 1, role: "user", content: "Kyoto 😀 / AUD 1,500. " + "Opening context. ".repeat(500) + "\nFinal condition remains Kyoto.", truncated: false },
  { ordinal: 2, role: "assistant", content: "Option one: temples. Option two: food and gardens.", truncated: false },
  { ordinal: 3, role: "user", content: "Use the second option.", truncated: false },
];
const serialize = plan => serializeContinuationSourcePlan({ plan, sourceId: snapshot.id,
  sourceConversationDigest: snapshot.conversationDigest, sourceDigestVersion: snapshot.digestVersion, attempt });
const restore = (manifest, rows = messages) => restoreContinuationSourcePlan({ manifest, messages: rows, snapshot });

test("recorded head/tail and UTF-16 selected/retrieved ranges round trip without source text", () => {
  for (const plan of [
    planContinuationSeed({ messages, sourceMessageCount: 3 }),
    planRetrievedContinuationSeed({ messages, selectedMessages: messages,
      passages: [{ ordinal: 1, start: 0, end: 22 }], retrievedMessages: messages,
      retrievedPassages: [{ ordinal: 2, start: 20, end: 48 }], sourceMessageCount: 3 }),
  ]) {
    const manifest = serialize(plan);
    const rebuilt = restore(JSON.parse(JSON.stringify(manifest)));
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(plan)));
    assert.equal(JSON.stringify(manifest).includes("Kyoto"), false);
    assert.equal(JSON.stringify(manifest).includes('"text"'), false);
    assert.equal(manifest.attempt.actualModelId, "fallback-model");
    assert.equal(manifest.attempt.attemptIndex, 1);
  }
});

test("explicit empty source selection stays empty rather than reconstructing recent source", () => {
  assert.equal(restore(serialize(emptyContinuationSeedPlan(3))).turns.length, 0);
});

test("source edits, deletion, changed binding and invalid ranges refuse evidence", () => {
  const manifest = serialize(planContinuationSeed({ messages, sourceMessageCount: 3 }));
  assert.throws(() => restore(manifest, messages.slice(1)));
  assert.throws(() => restore(manifest, messages.map(row => ({ ...row, content: "changed" + row.content }))));
  assert.throws(() => restoreContinuationSourcePlan({ manifest, messages, snapshot: { ...snapshot, digestVersion: 2 } }));
  const invalid = structuredClone(manifest);
  invalid.plan.turns[0].ranges[0].end = 9999999;
  assert.throws(() => restore(invalid));
});

test("malformed manifests do not fall back to legacy and do not accept extra source fields", () => {
  assert.throws(() => parseContinuationSourceManifest(null));
  assert.throws(() => parseContinuationSourceManifest({ ...serialize(emptyContinuationSeedPlan(3)), text: "secret" }));
});
