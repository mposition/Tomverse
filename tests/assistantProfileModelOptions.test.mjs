import assert from "node:assert/strict";
import test from "node:test";
import { modelSelectorOptions } from "../lib/assistantProfileModelOptions.ts";
import { settleAwaitedKnowledgeFiles } from "../lib/assistantKnowledgeAwait.ts";

const catalog = {
  publicModels: [
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "gpt-6-luna", name: "GPT 6 Luna" },
  ],
  getModel: (id) =>
    ({ "claude-sonnet-5": { name: "Claude Sonnet 5" } })[id],
};

test("the explicit list offers the live catalogue, not the static bootstrap list", () => {
  const options = modelSelectorOptions(catalog, []);
  assert.deepEqual(options.map((option) => option.id), ["claude-sonnet-5-5", "gpt-6-luna"]);
  assert.equal(options.every((option) => !option.unavailable), true);
});

test("a stored id the catalogue no longer offers is still shown, so it can be unticked", () => {
  // Production 2026-11-03: a stored `claude-sonnet-5-5` had no checkbox, so the
  // owner could not remove it and Chat refused the profile as multi-model.
  const options = modelSelectorOptions(catalog, ["claude-sonnet-5", "retired-unknown"]);
  assert.deepEqual(options.slice(2), [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", unavailable: true },
    { id: "retired-unknown", name: "retired-unknown", unavailable: true },
  ]);
  // A stored id the catalogue does offer is listed once, as itself.
  assert.equal(
    modelSelectorOptions(catalog, ["claude-sonnet-5-5"]).filter((option) => option.id === "claude-sonnet-5-5").length,
    1
  );
});

test("an uploaded file is selected once ready, waited for while processing, and dropped when it fails", () => {
  const settled = settleAwaitedKnowledgeFiles(new Set(["ready", "busy", "queued", "broken", "gone"]), [
    { id: "ready", processingStatus: "ready" },
    { id: "busy", processingStatus: "processing" },
    { id: "queued", processingStatus: "pending" },
    { id: "broken", processingStatus: "failed" },
    { id: "other", processingStatus: "ready" },
  ]);
  assert.deepEqual(settled.ready, ["ready"]);
  assert.deepEqual(settled.stillAwaiting, ["busy", "queued"]);
});
