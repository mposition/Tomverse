import assert from "node:assert/strict";
import test from "node:test";

import {
  AVAILABLE_MODELS,
  isPubliclySelectableModel,
  isRetiredModel,
  resolveSelectableModelId,
  type AiModel,
} from "../lib/models";

// UX-F003. Two independent defects let a model no provider would serve stay
// selectable:
//
//  * the client catalog's "public" filter checked only
//    publiclyListed/catalogDeleted, never enabled/status, and
//  * the registry bootstrap only ever INSERTed the static catalog
//    (createMany + skipDuplicates), so retiring a model in lib/models.ts never
//    reached a runtime row that already existed.
//
// These pin the shared lifecycle contract both sites now use.

// AVAILABLE_MODELS is declared as a literal tuple so each entry keeps its
// exact type; widening it once here lets these checks read optional lifecycle
// fields that only some entries carry.
const CATALOG = AVAILABLE_MODELS as readonly AiModel[];

const model = (overrides: Partial<AiModel>): AiModel =>
  ({
    id: "test-model",
    name: "Test Model",
    apiModel: "test-model",
    provider: "openai",
    icon: "*",
    bestFor: "testing",
    minimumPlan: "Free",
    usageClass: "standard",
    enabled: true,
    status: "enabled",
    ...overrides,
  }) as AiModel;

test("a delisted, disabled model with status disabled counts as retired", () => {
  assert.equal(
    isRetiredModel(
      model({ enabled: false, publiclyListed: false, status: "disabled" })
    ),
    true
  );
});

test("a merely disabled model is not retired", () => {
  // Temporarily disabled by an operator is a different state from retired:
  // it must not trigger the bootstrap's retirement replay.
  assert.equal(isRetiredModel(model({ enabled: false })), false);
  assert.equal(
    isRetiredModel(model({ enabled: false, status: "disabled" })),
    false
  );
});

test("a retired model is never publicly selectable", () => {
  assert.equal(
    isPubliclySelectableModel(
      model({ enabled: false, publiclyListed: false, status: "disabled" })
    ),
    false
  );
});

test("a disabled model is not selectable even while still publicly listed", () => {
  // The exact shape the runtime registry was left in: the row kept
  // publiclyListed=true after the catalog disabled the model.
  assert.equal(
    isPubliclySelectableModel(
      model({ enabled: false, status: "disabled", publiclyListed: true })
    ),
    false
  );
});

test("catalogDeleted and coming-soon models are not selectable", () => {
  assert.equal(isPubliclySelectableModel(model({ catalogDeleted: true })), false);
  assert.equal(isPubliclySelectableModel(model({ status: "coming-soon" })), false);
});

test("an ordinary enabled model is selectable", () => {
  assert.equal(isPubliclySelectableModel(model({})), true);
});

test("every retired model in the catalog names a live replacement", () => {
  const selectableIds = new Set(
    CATALOG.filter(isPubliclySelectableModel).map((entry) => entry.id)
  );
  const retired = CATALOG.filter(isRetiredModel);

  assert.ok(
    retired.length > 0,
    "expected the catalog to still carry retired models to cover"
  );

  for (const entry of retired) {
    assert.ok(
      entry.replacementModelId,
      `retired model ${entry.id} must name a replacement`
    );
    assert.ok(
      selectableIds.has(entry.replacementModelId!),
      `retired model ${entry.id} points at ${entry.replacementModelId}, which is not selectable`
    );
  }
});

test("no publicly selectable model is simultaneously retired", () => {
  const contradictory = CATALOG.filter(
    (entry) => isPubliclySelectableModel(entry) && isRetiredModel(entry)
  );
  assert.deepEqual(contradictory.map((entry) => entry.id), []);
});

test("groq llama-4-scout stays retired and unselectable", () => {
  // Groq removed Scout and recommends GPT-OSS as an open-model successor.
  const scout = CATALOG.find((entry) => entry.id === "llama-4-scout");
  assert.ok(scout, "llama-4-scout should remain in the catalog for history");
  assert.equal(isRetiredModel(scout!), true);
  assert.equal(isPubliclySelectableModel(scout!), false);
  assert.equal(scout!.replacementModelId, "groq-gpt-oss-120b");
});

test("provider retirements remain historical rows with exact replacements", () => {
  const expected = new Map([
    ["deepseek-r1", "deepseek-v4-flash"],
    ["grok-3", "grok-4-3"],
    ["llama-3-1", "groq-gpt-oss-120b"],
    ["llama-3-3", "groq-gpt-oss-120b"],
    ["llama-4-scout", "groq-gpt-oss-120b"],
  ]);

  for (const [id, replacementModelId] of expected) {
    const entry = CATALOG.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} must remain as a historical row`);
    assert.equal(entry.enabled, false, id);
    assert.equal(entry.status, "disabled", id);
    assert.equal(entry.publiclyListed, false, id);
    assert.equal(entry.replacementModelId, replacementModelId, id);
    assert.equal(resolveSelectableModelId(id), replacementModelId, id);
  }
});

test("replacement resolution follows bounded chains and rejects cycles", () => {
  const entries = new Map([
    ["old", model({ id: "old", enabled: false, status: "disabled", publiclyListed: false, replacementModelId: "middle" })],
    ["middle", model({ id: "middle", enabled: false, status: "disabled", publiclyListed: false, replacementModelId: "live" })],
    ["live", model({ id: "live" })],
    ["cycle-a", model({ id: "cycle-a", enabled: false, status: "disabled", publiclyListed: false, replacementModelId: "cycle-b" })],
    ["cycle-b", model({ id: "cycle-b", enabled: false, status: "disabled", publiclyListed: false, replacementModelId: "cycle-a" })],
  ]);
  const lookup = (id: string) => entries.get(id);

  assert.equal(resolveSelectableModelId("old", lookup), "live");
  assert.equal(resolveSelectableModelId("cycle-a", lookup), undefined);
  assert.equal(resolveSelectableModelId("missing", lookup), undefined);
});
