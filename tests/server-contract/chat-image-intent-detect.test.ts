// Contract: the chat image-intent triage is the Auto router's call, behind its
// own switch. Switch off or no router model means no call; a refused budget hold means no call; a made call
// returns only a model and preset from the enabled image catalogue.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

let routerModelId: string | null = "gpt-6-luna";
let imageTriageOn = true;
let budgetHeld = true;
let modelOutput: unknown = { image: true, modelId: "gpt-image-2", preset: "draft" };
let callThrows = false;
const calls: Array<{ prompt: string }> = [];
const reserved: number[] = [];
let mocksInstalled = false;

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realAi = require("ai") as Record<string, unknown>;
    const { AVAILABLE_MODELS } = require(resolve(ROOT, "lib/models.ts")) as {
      AVAILABLE_MODELS: readonly unknown[];
    };
    const { IMAGE_MODEL_REGISTRY } = require(
      resolve(ROOT, "lib/imageModelRegistry.ts")
    ) as { IMAGE_MODEL_REGISTRY: readonly unknown[] };
    mock.module("ai", {
      namedExports: {
        ...realAi,
        generateText: async (options: { prompt: string }) => {
          if (callThrows) throw new Error("timeout");
          calls.push({ prompt: options.prompt });
          return { output: modelOutput, usage: { inputTokens: 100, outputTokens: 10 } };
        },
      },
    });
    mock.module(mod("lib/autoLlmRouterSettings.ts"), {
      namedExports: {
        readAutoLlmRouterModelId: async () => routerModelId,
        readAutoLlmRouterImageTriage: async () => imageTriageOn,
      },
    });
    mock.module(mod("lib/autoLlmRouter.ts"), {
      namedExports: {
        reserveRouterCost: async (_provider: string, microUsd: number) => {
          reserved.push(microUsd);
          return budgetHeld;
        },
        settleRouterCost: async () => undefined,
      },
    });
    mock.module(mod("lib/modelRegistry.ts"), {
      namedExports: { getRuntimeModels: async () => AVAILABLE_MODELS },
    });
    mock.module(mod("lib/modelCatalog.ts"), {
      namedExports: { refreshImageModelCatalog: async () => IMAGE_MODEL_REGISTRY },
    });
    mock.module(mod("lib/activeAiModel.ts"), {
      namedExports: { getActiveAiModel: () => ({}) },
    });
  }
  return import(mod("lib/chatImageIntent.ts"));
}

const reset = () => {
  routerModelId = "gpt-6-luna";
  imageTriageOn = true;
  budgetHeld = true;
  modelOutput = { image: true, modelId: "gpt-image-2", preset: "draft" };
  callThrows = false;
  calls.length = 0;
  reserved.length = 0;
};

const detect = async (
  text = "간단한 고양이 아이콘 그려줘",
  chatModelIds?: readonly string[]
) => {
  const { detectChatImageRequest } = await load();
  return detectChatImageRequest({ text, traceId: "trace-1", chatModelIds });
};

test("the router model triages: model and preset come back", async () => {
  reset();
  assert.deepEqual(await detect(), { image: true, modelIds: ["gpt-image-2"], preset: "draft" });
  assert.equal(calls.length, 1);
  assert.equal(reserved.length, 1);
  assert.ok(reserved[0] > 0);
  assert.match(calls[0].prompt, /- gpt-image-2 \(/);
  assert.match(calls[0].prompt, /Message:\n간단한 고양이 아이콘 그려줘$/);
});

test("image triage switched off, no call", async () => {
  reset();
  imageTriageOn = false;
  assert.deepEqual(await detect(), { image: false });
  assert.equal(calls.length + reserved.length, 0);
});

test("no router model, no call", async () => {
  reset();
  routerModelId = null;
  assert.deepEqual(await detect(), { image: false });
  assert.equal(calls.length + reserved.length, 0);
});

test("an unknown router model, no call", async () => {
  reset();
  routerModelId = "not-a-model";
  assert.deepEqual(await detect(), { image: false });
  assert.equal(calls.length + reserved.length, 0);
});

test("a refused budget hold, no call", async () => {
  reset();
  budgetHeld = false;
  assert.deepEqual(await detect(), { image: false });
  assert.equal(reserved.length, 1);
  assert.equal(calls.length, 0);
});

test("blank text, no call", async () => {
  reset();
  assert.deepEqual(await detect("   "), { image: false });
  assert.equal(calls.length + reserved.length, 0);
});

test("a failed call or a 'no' goes to chat", async () => {
  reset();
  callThrows = true;
  assert.deepEqual(await detect(), { image: false });
  reset();
  modelOutput = { image: false, modelId: "gpt-image-2", preset: "draft" };
  assert.deepEqual(await detect(), { image: false });
});

test("a model outside the catalogue is not passed on", async () => {
  reset();
  modelOutput = { image: true, modelId: "made-up-image-model", preset: "final" };
  assert.deepEqual(await detect(), { image: true, modelIds: [], preset: null });
});

test("Review: the selected chat models' makers make the image; the call picks the preset", async () => {
  reset();
  process.env.IMAGE_GROUP_MAX_MODELS = "3";
  modelOutput = { image: true, modelId: "gpt-image-2", preset: "standard" };
  const decision = await detect("노을 진 바다 그려줘", [
    "claude-sonnet-5",
    "grok-4-5",
    "gpt-6-luna",
    "gemini-3-7-flash",
  ]);
  delete process.env.IMAGE_GROUP_MAX_MODELS;
  assert.equal(decision.image, true);
  assert.deepEqual(decision.image && decision.modelIds, [
    "grok-imagine-image-quality-20260403",
    "gpt-image-2",
    "fal-ai/nano-banana-2",
  ]);
  assert.equal(decision.image && decision.preset, "standard");
  assert.match(calls[0].prompt, /already chose these image models/);
});

test("Review: a preset one selected model lacks is dropped", async () => {
  reset();
  modelOutput = { image: true, modelId: "gpt-image-2", preset: "final" };
  const decision = await detect("정교한 포스터 그려줘", ["gpt-6-luna", "grok-4-5"]);
  assert.deepEqual(decision, {
    image: true,
    modelIds: ["gpt-image-2", "grok-imagine-image-quality-20260403"],
    preset: null,
  });
});

test("Review: no maker with an image model falls back to the triage's pick", async () => {
  reset();
  modelOutput = { image: true, modelId: "gpt-image-2", preset: "draft" };
  assert.deepEqual(await detect("고양이 그려줘", ["claude-sonnet-5"]), {
    image: true,
    modelIds: ["gpt-image-2"],
    preset: "draft",
  });
  assert.doesNotMatch(calls[0].prompt, /already chose/);
});
