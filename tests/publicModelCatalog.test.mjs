import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NON_PUBLIC_MODEL_FIELDS,
  toPublicCatalogModel,
} from "../lib/publicModelCatalog.ts";
import {
  AVAILABLE_MODELS,
  isPubliclySelectableModel,
} from "../lib/models.ts";
import { STATIC_RUNTIME_MODELS } from "../lib/modelRegistryShared.ts";

// /api/models/catalog is served without a session, because guests choose
// models before signing in and shared conversations are read by people with
// no account. It used to return the registry row with three fields deleted,
// so Tomverse's own cost basis -- input/output USD per million tokens, the
// cached-input multiplier and reservation sizing -- was published for every
// model to anyone who asked. docs/policy/credit-and-cost-limits.md forbids
// raw internal USD in a user-facing response.
//
// These assert the public body by *name*, not by re-listing the allowlist,
// so a field added to AiModel later cannot become public by default.

const CATALOG = STATIC_RUNTIME_MODELS;

const publicBody = () => CATALOG.map(toPublicCatalogModel);

test("no public catalogue entry carries an internal cost or operational field", () => {
  const leaked = [];
  for (const model of publicBody()) {
    for (const field of NON_PUBLIC_MODEL_FIELDS) {
      if (field in model) leaked.push(`${model.id}.${field}`);
    }
  }
  assert.deepEqual(leaked, []);
});

test("no public field name so much as mentions USD", () => {
  // Broader than the named list: catches a differently-spelled price field
  // added later, which the list itself cannot anticipate.
  const offenders = new Set();
  for (const model of publicBody()) {
    for (const key of Object.keys(model)) {
      if (/usd|price|cost/i.test(key)) offenders.add(key);
    }
  }
  assert.deepEqual([...offenders], []);
});

test("the price a user is actually charged in is still there", () => {
  // Credits are the user-facing unit; removing the USD rates must not take
  // the picker's cost display with them.
  for (const model of publicBody()) {
    assert.equal(
      typeof model.creditWeight,
      "number",
      `${model.id} must keep its credit weight`
    );
  }
});

test("every field the UI reads off a catalogue model survives", () => {
  // The set the client genuinely consumes: identity, plan gating, the
  // picker's badges and filters, and attachment gating.
  const required = [
    "id",
    "name",
    "provider",
    "icon",
    "bestFor",
    "minimumPlan",
    "usageClass",
    "enabled",
    "status",
  ];
  for (const model of publicBody()) {
    for (const field of required) {
      assert.ok(field in model, `${model.id} is missing ${field}`);
    }
  }

  const withImage = publicBody().find((model) => model.inputCapabilities?.image);
  assert.ok(withImage, "image capability must survive -- attachment gating reads it");
  const withReasoning = publicBody().find((model) => model.reasoning);
  assert.ok(withReasoning, "reasoning must survive -- the picker filters on it");
  const withContext = publicBody().find((model) => model.contextWindowTokens);
  assert.ok(withContext, "context window must survive -- the picker displays it");
});

test("a retired model is still resolvable, with the note that explains it", () => {
  // The reason the endpoint returns every row rather than only the selectable
  // ones: a stored conversation naming a retired model has to render a name,
  // an icon and where the user should go instead.
  const retired = publicBody().filter(
    (model) => model.enabled === false && model.status === "disabled"
  );
  assert.ok(retired.length > 0, "expected the catalogue to carry retired rows");

  for (const model of retired) {
    assert.ok(model.name, `${model.id} must keep a display name`);
    assert.ok(model.icon, `${model.id} must keep an icon`);
    assert.ok(
      model.replacementModelId,
      `${model.id} must still name where the user should go`
    );
  }

  const scout = publicBody().find((model) => model.id === "llama-4-scout");
  assert.ok(scout);
  assert.equal(scout.userVisibleNote, "This model was retired and replaced by Gemini 3.6 Flash.");
});

test("the administrators-only explanation is not the one users receive", () => {
  // operationalReason and userVisibleNote both exist on retired rows and only
  // one of them is safe to publish.
  const withBoth = CATALOG.filter(
    (model) => model.operationalReason && model.userVisibleNote
  );
  assert.ok(withBoth.length > 0, "expected a row carrying both explanations");

  for (const model of withBoth) {
    const published = toPublicCatalogModel(model);
    assert.equal("operationalReason" in published, false, model.id);
    assert.equal(published.userVisibleNote, model.userVisibleNote, model.id);
  }
});

test("the picker's list is unchanged by the trimming", () => {
  // isPubliclySelectableModel reads enabled/publiclyListed/status/
  // catalogDeleted, so all four have to survive for the client to derive the
  // same set the server would.
  const fromPublicBody = publicBody()
    .filter(isPubliclySelectableModel)
    .map((model) => model.id);
  const fromCatalogue = CATALOG.filter(isPubliclySelectableModel).map(
    (model) => model.id
  );
  assert.deepEqual(fromPublicBody, fromCatalogue);
  assert.ok(fromPublicBody.length > 0);

  for (const id of ["llama-3-1", "llama-4-scout", "grok-4", "grok-3-mini"]) {
    assert.equal(
      fromPublicBody.includes(id),
      false,
      `${id} is retired and must not reach the picker`
    );
    assert.ok(
      publicBody().some((model) => model.id === id),
      `${id} must still be resolvable for stored conversations`
    );
  }
});

test("ordering survives dropping sortOrder", () => {
  // sortOrder is not published; the array order carries it instead.
  assert.deepEqual(
    publicBody().map((model) => model.id),
    CATALOG.map((model) => model.id)
  );
});

test("the route builds its body through the allowlist, not by deleting fields", () => {
  // The defect was structural: `{...model}` plus three `delete`s meant any
  // field added later shipped publicly by default. This fails if that shape
  // comes back.
  const source = readFileSync(
    join(import.meta.dirname, "..", "app", "api", "models", "catalog", "route.ts"),
    "utf8"
  );
  assert.match(source, /toPublicCatalogModel/);
  assert.doesNotMatch(
    source,
    /\bdelete\s+\w+\./,
    "build the public body from an allowlist rather than deleting fields off the registry row"
  );
});

test("every model in the catalogue is published, none filtered away server-side", () => {
  assert.equal(publicBody().length, AVAILABLE_MODELS.length);
});
