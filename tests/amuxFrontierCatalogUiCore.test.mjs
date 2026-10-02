import assert from "node:assert/strict";
import test from "node:test";

import { readAvailableFrontierModels } from "../lib/amux/ideaFrontierCatalogUiCore.ts";

const model = { approvalId: "approval_123", approvalVersion: 1,
  provider: "openai", modelId: "gpt-frontier", allowedEfforts: ["high"] };
const reply = { state: "available", models: [model], transferAuthorized: false };

test("only a bounded no-transfer approved model list is displayed", () => {
  assert.deepEqual(readAvailableFrontierModels(200, reply), [model]);
  assert.equal(readAvailableFrontierModels(200, { ...reply, transferAuthorized: true }), null);
  assert.equal(readAvailableFrontierModels(503, reply), null);
  assert.equal(readAvailableFrontierModels(200, { ...reply, models: [model, model] }), null);
  assert.equal(readAvailableFrontierModels(200, { ...reply,
    models: [{ ...model, allowedEfforts: ["fast"] }] }), null);
});
