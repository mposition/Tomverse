import assert from "node:assert/strict";
import test from "node:test";

import {
  getWebSearchCapability,
  modelWebSearchIsDispatchable,
  webSearchCapabilityFromCode,
} from "../lib/webSearchCapability.ts";
import {
  ALL_WEB_SEARCH_BACKENDS_READY,
  NO_WEB_SEARCH_BACKENDS,
} from "../lib/webSearchBackends.ts";
import {
  WEB_SEARCH_OVERRIDES,
  webSearchOverrideRefusal,
} from "../lib/webSearchOverride.ts";
import {
  createModelRegistrySchema,
  registryInputToData,
  updateModelRegistrySchema,
} from "../lib/modelRegistryAdmin.ts";
import { registryRowToModel } from "../lib/modelRegistry.ts";
import { staticModelRegistrySeedRows } from "../lib/modelRegistryShared.ts";
import { toPublicCatalogModel } from "../lib/publicModelCatalog.ts";

// An administrator's per-model web search override (lib/webSearchOverride.ts).
// The rule every case below serves: an override can only move a model onto a
// route whose worst case this application already bounds -- off, or the
// application-managed backend -- and never onto a provider's native tool.

test("the closed list has no value for a provider's native tool", () => {
  assert.deepEqual([...WEB_SEARCH_OVERRIDES], ["off", "app-managed"]);
});

test("no override follows the code", () => {
  const luna = { id: "gpt-5-6-luna", provider: "openai" };
  assert.deepEqual(getWebSearchCapability(luna), webSearchCapabilityFromCode(luna));
  assert.equal(getWebSearchCapability({ ...luna, webSearchOverride: null }).support, "native");
  // An id cannot carry an override; only a row can.
  assert.equal(getWebSearchCapability("gpt-5-6-luna").support, "native");
});

test("off stops a native model and an application-managed one from searching", () => {
  for (const model of [
    { id: "gpt-5-6-luna", provider: "openai" },
    { id: "gpt-6-luna", provider: "openai" },
    { id: "mistral-small-4", provider: "mistral" },
  ]) {
    const capability = getWebSearchCapability({ ...model, webSearchOverride: "off" });
    assert.equal(capability.support, "unsupported", model.id);
    assert.equal(
      modelWebSearchIsDispatchable(
        { ...model, webSearchOverride: "off" },
        ALL_WEB_SEARCH_BACKENDS_READY
      ),
      false,
      model.id
    );
  }
});

test("app-managed moves a native model onto the application's backend, never the other way", () => {
  const capability = getWebSearchCapability({
    id: "gpt-5-6-luna",
    provider: "openai",
    webSearchOverride: "app-managed",
  });
  assert.equal(capability.support, "app-managed");
  assert.equal(capability.searchBackend, "brave");
  assert.equal(capability.provider, undefined);
  // Still subject to this deployment's readiness: an override does not make a
  // backend reachable.
  assert.equal(
    modelWebSearchIsDispatchable(
      { id: "gpt-5-6-luna", provider: "openai", webSearchOverride: "app-managed" },
      NO_WEB_SEARCH_BACKENDS
    ),
    false
  );
});

test("an unknown stored value is ignored rather than trusted", () => {
  const capability = getWebSearchCapability({
    id: "gpt-5-6-luna",
    provider: "openai",
    webSearchOverride: "native",
  });
  assert.equal(capability.support, "native");
  assert.equal(capability.provider, "openai");
});

test("Perplexity takes no override, and a stored one is ignored", () => {
  assert.match(webSearchOverrideRefusal("perplexity", "off") ?? "", /Perplexity/);
  assert.equal(webSearchOverrideRefusal("perplexity", null), null);
  assert.equal(webSearchOverrideRefusal("openai", "off"), null);
  for (const webSearchOverride of WEB_SEARCH_OVERRIDES) {
    assert.equal(
      getWebSearchCapability({
        id: "perplexity/sonar",
        provider: "perplexity",
        webSearchOverride,
      }).support,
      "search-model"
    );
  }
});

// ---------------------------------------------------------------------------
// The admin write path.
// ---------------------------------------------------------------------------

const base = {
  name: "Test model",
  apiModel: "test-model",
  provider: "openai",
  icon: "",
  bestFor: "",
  minimumPlan: "Free",
  usageClass: "standard",
  creditWeight: 1,
  publiclyListed: true,
  status: "enabled",
  operationalReason: "",
  userVisibleNote: "",
  supportsImage: false,
  supportsNativePdf: false,
  sortOrder: 0,
};

test("the admin schema accepts the closed list and null, and nothing else", () => {
  for (const webSearchOverride of [null, "off", "app-managed"]) {
    assert.equal(
      updateModelRegistrySchema.safeParse({ ...base, webSearchOverride }).success,
      true,
      String(webSearchOverride)
    );
  }
  for (const webSearchOverride of ["native", "auto", "", 1]) {
    assert.equal(
      updateModelRegistrySchema.safeParse({ ...base, webSearchOverride }).success,
      false,
      String(webSearchOverride)
    );
  }
});

test("the admin schema refuses an override for Perplexity", () => {
  const result = createModelRegistrySchema.safeParse({
    ...base,
    id: "perplexity-test",
    provider: "perplexity",
    webSearchOverride: "off",
  });
  assert.equal(result.success, false);
  assert.ok(
    result.error.issues.some((issue) => issue.path.join(".") === "webSearchOverride")
  );
});

test("a save that omits the field keeps what is stored; null clears it", () => {
  const actor = { id: null, email: null };
  const omitted = registryInputToData(updateModelRegistrySchema.parse(base), actor);
  assert.equal("webSearchOverride" in omitted, false);
  const cleared = registryInputToData(
    updateModelRegistrySchema.parse({ ...base, webSearchOverride: null }),
    actor
  );
  assert.equal(cleared.webSearchOverride, null);
  const set = registryInputToData(
    updateModelRegistrySchema.parse({ ...base, webSearchOverride: "off" }),
    actor
  );
  assert.equal(set.webSearchOverride, "off");
});

// ---------------------------------------------------------------------------
// The read path: registry row -> runtime model -> public catalogue.
// ---------------------------------------------------------------------------

const registryRow = (webSearchOverride) => {
  const seed = staticModelRegistrySeedRows().find((entry) => entry.id === "gpt-5-6-luna");
  assert.ok(seed);
  return {
    ...seed,
    webSearchOverride,
    updatedById: null,
    updatedByEmail: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
};

test("a registry row carries its override to the runtime model and the public catalogue", () => {
  const model = registryRowToModel(registryRow("off"));
  assert.equal(model.webSearchOverride, "off");
  assert.equal(getWebSearchCapability(model).support, "unsupported");
  assert.equal(toPublicCatalogModel(model).webSearchOverride, "off");
});

test("a row without an override publishes none and follows the code", () => {
  const model = registryRowToModel(registryRow(null));
  assert.equal("webSearchOverride" in model, false);
  assert.equal("webSearchOverride" in toPublicCatalogModel(model), false);
  assert.equal(getWebSearchCapability(model).support, "native");
});

test("a stored value outside the closed list never reaches the runtime model", () => {
  const model = registryRowToModel(registryRow("native"));
  assert.equal("webSearchOverride" in model, false);
});

test("seeding never writes the column, so every seeded model follows the code", () => {
  for (const row of staticModelRegistrySeedRows()) {
    assert.equal("webSearchOverride" in row, false, row.id);
  }
});
