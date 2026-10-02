import assert from "node:assert/strict";
import test from "node:test";

import { readAvailableFrontierModels, readCheckedFrontierSelection } from "../lib/amux/ideaFrontierCatalogUiCore.ts";

const model = { approvalId: "123e4567-e89b-42d3-a456-426614174000", approvalVersion: 1,
  provider: "openai", modelId: "gpt-frontier", allowedEfforts: ["high"] };
const reply = { state: "available", models: [model], transferAuthorized: false };

test("only a bounded no-transfer approved model list is displayed", () => {
  assert.deepEqual(readAvailableFrontierModels(200, reply), [model]);
  assert.equal(readAvailableFrontierModels(200, { ...reply, transferAuthorized: true }), null);
  assert.equal(readAvailableFrontierModels(503, reply), null);
  assert.equal(readAvailableFrontierModels(200, { ...reply, models: [model, model] }), null);
  assert.equal(readAvailableFrontierModels(200, { ...reply,
    models: [{ ...model, approvalId: "approval_123" }] }), null);
  assert.equal(readAvailableFrontierModels(200, { ...reply,
    models: [{ ...model, allowedEfforts: ["fast"] }] }), null);
});

test("a selection check must match the visible revision and never confer transfer authority", () => {
  const checked = { state: "current", approvalId: model.approvalId,
    approvalVersion: model.approvalVersion, transferAuthorized: false };
  assert.deepEqual(readCheckedFrontierSelection(200, checked, model), {
    approvalId: model.approvalId, approvalVersion: model.approvalVersion,
  });
  assert.equal(readCheckedFrontierSelection(200, { ...checked, transferAuthorized: true }, model), null);
  assert.equal(readCheckedFrontierSelection(200, { ...checked, approvalVersion: 2 }, model), null);
  assert.equal(readCheckedFrontierSelection(503, checked, model), null);
});
