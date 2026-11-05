import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AiModel } from "@/lib/models";

/**
 * What a user is told when the model they asked for cannot answer, resolved
 * against the runtime registry rather than against the checked-in catalogue.
 *
 * ## The gap this closes
 *
 * `lib/models.ts` refuses at import time to carry a retirement whose
 * replacement is not publicly selectable, so every link in the catalogue is
 * live by construction. The registry those links actually travel through has
 * no such guarantee: an administrator retires A onto B, B is retired onto C
 * months later, and nothing revisits A. `assertModelRuntimeAvailable` read
 * one hop and reported whatever it found, so A's notice named B -- a model
 * that is not in anybody's picker -- and a retirement naming nobody at all
 * came out as "temporarily unavailable", which is the wrong thing to tell
 * somebody whose model is gone for good.
 *
 * The registry is mocked rather than seeded because the rule under test is
 * about lifecycle shapes, not about Prisma: the shapes below are the ones
 * production drifts into, and a database is not needed to build them.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const baseModel = (overrides: Partial<AiModel>): AiModel =>
  ({
    id: "model",
    name: "Model",
    apiModel: "model",
    provider: "openai",
    icon: "*",
    bestFor: "testing",
    minimumPlan: "Free",
    usageClass: "standard",
    enabled: true,
    status: "enabled",
    ...overrides,
  }) as AiModel;

const retired = (overrides: Partial<AiModel>): AiModel =>
  baseModel({
    enabled: false,
    status: "disabled",
    publiclyListed: false,
    ...overrides,
  });

// One mock and one import for the file: a module may only be mocked once per
// process, and the registry is the seam, so the rows are swapped per case
// instead.
let registryModels: readonly AiModel[] = [];
mock.module(mod("lib/modelRegistry.ts"), {
  namedExports: { getRuntimeModels: async () => [...registryModels] },
});
let availability: typeof import("@/lib/modelAvailability") | undefined;

const loadAvailability = async (models: readonly AiModel[]) => {
  registryModels = models;
  availability ??= (await import(
    mod("lib/modelAvailability.ts")
  )) as typeof import("@/lib/modelAvailability");
  return availability;
};

test("a retirement chain names the first model the user could actually pick", async () => {
  const { assertModelRuntimeAvailable } = await loadAvailability([
    retired({ id: "first", name: "First", replacementModelId: "second" }),
    retired({ id: "second", name: "Second", replacementModelId: "third" }),
    baseModel({ id: "third", name: "Third" }),
  ]);

  const verdict = await assertModelRuntimeAvailable("first");
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.notice, {
    source: "localised",
    kind: "retired_replaced",
    copyKey: "chat.modelRetiredWithReplacement",
    replacementModelName: "Third",
  });
  assert.match(verdict.reason ?? "", /Third/);
  // The dead link in the middle of the chain is never offered.
  assert.doesNotMatch(verdict.reason ?? "", /Second/);
});

test("a retirement whose chain dead-ends says support ended instead of naming it", async () => {
  const { assertModelRuntimeAvailable } = await loadAvailability([
    retired({ id: "first", name: "First", replacementModelId: "second" }),
    retired({ id: "second", name: "Second" }),
    baseModel({ id: "live", name: "Live" }),
  ]);

  const verdict = await assertModelRuntimeAvailable("first");
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.notice, {
    source: "localised",
    kind: "retired",
    copyKey: "chat.modelRetired",
  });
  // Not the unrelated live model either: the picker decides what to offer.
  assert.doesNotMatch(verdict.reason ?? "", /Second|Live/);
});

test("a retirement that names nobody is still called a retirement", async () => {
  const { assertModelRuntimeAvailable } = await loadAvailability([
    retired({ id: "only", name: "Only" }),
  ]);

  assert.deepEqual((await assertModelRuntimeAvailable("only")).notice, {
    source: "localised",
    kind: "retired",
    copyKey: "chat.modelRetired",
  });
});

test("a model switched off while still listed is only temporarily unavailable", async () => {
  // An operator's incident switch, not a retirement: the row keeps
  // publiclyListed, and the model is expected back.
  const { assertModelRuntimeAvailable } = await loadAvailability([
    baseModel({
      id: "paused",
      name: "Paused",
      enabled: false,
      status: "disabled",
      publiclyListed: true,
    }),
  ]);

  const verdict = await assertModelRuntimeAvailable("paused");
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.notice, {
    source: "localised",
    kind: "unavailable",
    copyKey: "chat.modelTemporarilyUnavailable",
  });
});

test("an operator's own note still wins over anything derived", async () => {
  const { assertModelRuntimeAvailable } = await loadAvailability([
    retired({
      id: "left-product",
      name: "Left Product",
      replacementModelId: "gone",
      userVisibleNote: "Not available in Tomverse Review. Use Live instead.",
    }),
    retired({ id: "gone", name: "Gone" }),
    baseModel({ id: "live", name: "Live" }),
  ]);

  assert.deepEqual(
    (await assertModelRuntimeAvailable("left-product")).notice,
    {
      source: "operator",
      text: "Not available in Tomverse Review. Use Live instead.",
    }
  );
});

test("a model that answers is allowed with nothing to say", async () => {
  const { assertModelRuntimeAvailable } = await loadAvailability([
    baseModel({ id: "live", name: "Live", replacementModelId: "other" }),
    baseModel({ id: "other", name: "Other" }),
  ]);

  assert.deepEqual(await assertModelRuntimeAvailable("live"), {
    allowed: true,
    reason: null,
    notice: null,
  });
});

test("an unknown model id is refused without inventing a notice", async () => {
  const { assertModelRuntimeAvailable } = await loadAvailability([
    baseModel({ id: "live", name: "Live" }),
  ]);

  assert.deepEqual(await assertModelRuntimeAvailable("absent"), {
    allowed: false,
    reason: "Unknown model.",
    notice: null,
  });
});
