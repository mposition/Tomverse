import assert from "node:assert/strict";
import test from "node:test";

import { groupImageModelsByOwner } from "../../components/chat/ImageModelTabPanel";

const model = (id: string, provider: string, modelOwner?: string) =>
  ({ id, provider, ...(modelOwner ? { modelOwner } : {}) }) as unknown as Parameters<
    typeof groupImageModelsByOwner
  >[0][number];

test("image models group by owner, OpenAI then Google first, catalogue order within a group", () => {
  const groups = groupImageModelsByOwner([
    model("nano-banana-2", "fal", "google"),
    model("grok", "xai"),
    model("flash-lite", "google"),
    model("qwen-3", "qwen"),
    model("gpt-flare", "openai"),
    model("nano-banana-2.1", "google"),
    model("gpt-sunburst", "openai"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.owner, group.models.map((entry) => entry.id)]),
    [
      ["openai", ["gpt-flare", "gpt-sunburst"]],
      // fal supplies Nano Banana 2, but it is Google's model.
      ["google", ["nano-banana-2", "flash-lite", "nano-banana-2.1"]],
      ["xai", ["grok"]],
      ["qwen", ["qwen-3"]],
    ]
  );
  assert.deepEqual(groupImageModelsByOwner([]), []);
});

test("every image use case has its line in every language, and seed models carry one the list can show", async () => {
  // Owner request 2026-11-15: the image model list describes each model the
  // way the chat list does ("Fast everyday questions"), not by provider alone.
  const { IMAGE_USE_CASE_LABEL_KEYS } = await import("../../components/chat/ImageModelTabPanel");
  const { IMAGE_USE_CASES } = await import("../../lib/runtimeImageProviders");
  const { IMAGE_MODEL_REGISTRY } = await import("../../lib/imageModelRegistry");
  const { imageFullProfileSchema, imageProfileOverrideSchema } = await import("../../lib/modelCatalogCore");
  assert.deepEqual(Object.keys(IMAGE_USE_CASE_LABEL_KEYS).sort(), [...IMAGE_USE_CASES].sort());
  const locales = await Promise.all(
    ["de", "en", "es", "fr", "ko", "pt", "zh", "zhHant"].map(async (name) => {
      const loaded = (await import(`../../locales/${name}`)) as Record<string, { chat: Record<string, string> }>;
      return [name, loaded[name].chat] as const;
    })
  );
  for (const key of Object.values(IMAGE_USE_CASE_LABEL_KEYS)) {
    const field = key.replace("chat.", "");
    const lines = locales.map(([name, chat]) => {
      assert.ok(typeof chat[field] === "string" && chat[field].trim().length > 0, `${name}.${key}`);
      return chat[field];
    });
    // Translated, not copied from English into the other seven.
    assert.ok(new Set(lines).size >= 6, key);
  }
  const seeded = IMAGE_MODEL_REGISTRY.filter((model) => model.useCase);
  assert.ok(seeded.length >= 1);
  for (const model of seeded) assert.ok((IMAGE_USE_CASES as readonly string[]).includes(model.useCase!), model.id);
  assert.equal(imageProfileOverrideSchema.safeParse({ useCase: "fast" }).success, true);
  assert.equal(imageProfileOverrideSchema.safeParse({ useCase: "cheap" }).success, false);
  assert.equal("useCase" in imageFullProfileSchema.shape, true);
});
