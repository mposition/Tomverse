import assert from "node:assert/strict";
import test from "node:test";

import { APP_DEFAULTS } from "../lib/appDefaults.ts";
import {
  moveCombinationLead,
  normalizeNewConversationModelIdsForWrite,
  parseStoredNewConversationModelIds,
  resolveNewConversationModels,
} from "../lib/newConversationModels.ts";

// The single interpreter of UserSettings.newConversationModelIds
// (docs/policy/default-model-luna-migration.md §1.2). These fixtures pin the
// null fallback, the defensive parse, the replacement chain, plan access and
// the stored/effective split -- with an injected catalogue, no database.

const model = (id, overrides = {}) => ({
  id,
  name: id,
  apiModel: id,
  provider: "openai",
  icon: "",
  enabled: true,
  status: "enabled",
  publiclyListed: true,
  catalogDeleted: false,
  minimumPlan: "Guest",
  ...overrides,
});

const CATALOGUE = [
  model("alpha"),
  model("bravo"),
  model("charlie"),
  model("delta"),
  model("disabled-model", { enabled: false, status: "disabled" }),
  model("retired-model", {
    enabled: false,
    status: "disabled",
    replacementModelId: "bravo",
  }),
  model("unlisted-model", { publiclyListed: false }),
  model("deleted-model", { catalogDeleted: true }),
  model("pro-only-model", { minimumPlan: "Pro" }),
];

const resolve = (stored, overrides = {}) =>
  resolveNewConversationModels({
    stored,
    defaultModel: "alpha",
    models: CATALOGUE,
    plan: "Free",
    ...overrides,
  });

test("DB null, JSON null and undefined are unset, never malformed", () => {
  for (const raw of [null, undefined]) {
    assert.deepEqual(parseStoredNewConversationModelIds(raw), {
      modelIds: null,
      malformed: false,
    });
  }
});

test("non-arrays, empty arrays and non-string entries are malformed", () => {
  for (const raw of ["alpha", 7, { modelIds: ["alpha"] }, [], ["alpha", 3], [" "]]) {
    assert.equal(parseStoredNewConversationModelIds(raw).malformed, true, JSON.stringify(raw));
    assert.equal(parseStoredNewConversationModelIds(raw).modelIds, null);
  }
});

test("an unset column resolves to [defaultModel] with no drift", () => {
  const resolved = resolve(null);
  assert.deepEqual(resolved, {
    storedModelIds: null,
    effectiveModelIds: ["alpha"],
    effectiveDefaultModelId: "alpha",
    changed: false,
    reasons: [],
  });
});

test("a malformed value falls back with a diagnostic but no user-facing change", () => {
  const resolved = resolve("not-an-array");
  assert.deepEqual(resolved.effectiveModelIds, ["alpha"]);
  assert.deepEqual(resolved.reasons, ["stored_value_malformed"]);
  assert.equal(resolved.changed, false);
});

test("a valid stored combination is used as-is", () => {
  const resolved = resolve(["bravo", "charlie", "alpha"]);
  assert.deepEqual(resolved.effectiveModelIds, ["bravo", "charlie", "alpha"]);
  assert.equal(resolved.effectiveDefaultModelId, "bravo");
  assert.equal(resolved.changed, false);
  // Lead differs from the defaultModel column: diagnosed, not rewritten.
  assert.deepEqual(resolved.reasons, ["default_model_out_of_sync"]);
});

test("duplicates collapse and more than three ids are truncated", () => {
  const resolved = resolve(["alpha", "alpha", "bravo", "charlie", "delta"]);
  assert.deepEqual(resolved.effectiveModelIds, ["alpha", "bravo", "charlie"]);
  assert.ok(resolved.reasons.includes("duplicates_removed"));
  assert.ok(resolved.reasons.includes("over_limit_truncated"));
  assert.equal(resolved.changed, true);
});

test("a retired model follows its replacement chain and reports the change", () => {
  const resolved = resolve(["retired-model", "alpha"]);
  assert.deepEqual(resolved.effectiveModelIds, ["bravo", "alpha"]);
  assert.ok(resolved.reasons.includes("model_replaced"));
  assert.equal(resolved.changed, true);
});

test("unknown, disabled, unlisted and deleted models drop with a reason", () => {
  for (const badId of [
    "never-existed",
    "disabled-model",
    "unlisted-model",
    "deleted-model",
  ]) {
    const resolved = resolve([badId, "alpha"]);
    assert.deepEqual(resolved.effectiveModelIds, ["alpha"], badId);
    assert.ok(resolved.reasons.includes("model_unavailable"), badId);
    assert.equal(resolved.changed, true, badId);
  }
});

test("a plan-locked model drops with its own reason and no auto-upgrade", () => {
  const resolved = resolve(["pro-only-model", "alpha"]);
  assert.deepEqual(resolved.effectiveModelIds, ["alpha"]);
  assert.ok(resolved.reasons.includes("model_plan_locked"));
  const proResolved = resolve(["pro-only-model", "alpha"], { plan: "Pro" });
  assert.deepEqual(proResolved.effectiveModelIds, ["pro-only-model", "alpha"]);
});

test("when nothing stored survives, the combination falls back to the lead", () => {
  const resolved = resolve(["never-existed", "disabled-model"]);
  assert.deepEqual(resolved.effectiveModelIds, ["alpha"]);
  assert.ok(resolved.reasons.includes("fallback_to_default_model"));
  assert.equal(resolved.changed, true);
});

test("a dead defaultModel resolves through its chain, then the compiled default", () => {
  const replaced = resolve(null, { defaultModel: "retired-model" });
  assert.deepEqual(replaced.effectiveModelIds, ["bravo"]);
  assert.ok(replaced.reasons.includes("default_model_replaced"));
  assert.equal(replaced.changed, true);

  const gone = resolve(null, { defaultModel: "never-existed" });
  assert.deepEqual(gone.effectiveModelIds, [APP_DEFAULTS.defaultModelId]);
  assert.equal(gone.changed, true);
});

test("write normalization accepts a clean selectable combination", () => {
  const normalized = normalizeNewConversationModelIdsForWrite({
    requested: ["charlie", "alpha"],
    models: CATALOGUE,
    plan: "Free",
  });
  assert.deepEqual(normalized, { ok: true, modelIds: ["charlie", "alpha"] });
});

test("write normalization rejects instead of silently repairing", () => {
  const reject = (requested, plan = "Free") =>
    normalizeNewConversationModelIdsForWrite({
      requested,
      models: CATALOGUE,
      plan,
    });
  assert.deepEqual(reject([]), { ok: false, rejection: "empty" });
  assert.equal(reject(["a", "b", "c", "d"]).rejection, "too_many_models");
  assert.equal(reject(["alpha", 5]).rejection, "invalid_entry");
  assert.equal(reject(["alpha", "alpha"]).rejection, "duplicate_model");
  assert.equal(reject(["never-existed"]).rejection, "model_not_selectable");
  // A retired model resolves on read, but an explicit save must name a model
  // that is selectable right now.
  assert.equal(reject(["retired-model"]).rejection, "model_not_selectable");
  assert.equal(reject(["unlisted-model"]).rejection, "model_not_selectable");
  assert.equal(reject(["pro-only-model"]).rejection, "model_plan_locked");
  assert.equal(reject(["pro-only-model"], "Pro").ok, true);
});

test("a legacy defaultModel-only save moves the lead and drops the last on overflow", () => {
  assert.deepEqual(moveCombinationLead(null, "alpha"), ["alpha"]);
  assert.deepEqual(moveCombinationLead(["alpha", "bravo"], "bravo"), [
    "bravo",
    "alpha",
  ]);
  // New lead not in a full combination: order kept, LAST item dropped.
  assert.deepEqual(
    moveCombinationLead(["alpha", "bravo", "charlie"], "delta"),
    ["delta", "alpha", "bravo"]
  );
  // Already the lead: unchanged.
  assert.deepEqual(moveCombinationLead(["alpha", "bravo"], "alpha"), [
    "alpha",
    "bravo",
  ]);
});

test("existing-conversation fallbacks stay single-model, only new creations use the combination", async () => {
  // Pinned at source level: the GET list's per-row fallback for an existing
  // conversation is the single representative model, never the account's
  // new-conversation combination -- applying the combination there would
  // silently widen an old single-model conversation into several panels.
  const { readFileSync } = await import("node:fs");
  const route = readFileSync(
    new URL("../app/api/conversations/route.ts", import.meta.url),
    "utf8"
  );
  const getSection = route.slice(
    route.indexOf("export async function GET"),
    route.indexOf("export async function POST")
  );
  const postSection = route.slice(route.indexOf("export async function POST"));
  assert.match(
    getSection,
    /\[resolvedDefaultEngine = APP_DEFAULTS\.defaultModelId\]/,
    "the GET list fallback must stay a single resolved representative model"
  );
  assert.ok(
    !getSection.includes("resolveNewConversationModels"),
    "the GET list must not apply the new-conversation combination to existing rows"
  );
  assert.ok(
    postSection.includes("resolveNewConversationModels"),
    "the POST creation fallback must go through the shared resolver"
  );
});
