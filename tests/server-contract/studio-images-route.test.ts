import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const url = (path: string) => pathToFileURL(resolve(root, path)).href;
const requireModule = createRequire(import.meta.url);
type GenerationInput = Parameters<typeof import("@/lib/imageGenerationService").requestImageGeneration>[0];
type BindInput = Parameters<typeof import("@/lib/studioImageReference").bindStudioImageUpload>[1];

process.env.NEXTAUTH_URL = "http://127.0.0.1:3100";
process.env.DATABASE_URL = "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.E2E_DISABLE_DATABASE = "true";

const owner = { id: "studio-user", email: "studio@example.invalid" };
let signedIn = true;
let receipt: { id: string } | null = null;
let globalGate = true;
const reservations: GenerationInput[] = [];
const attachments: BindInput[] = [];
const receipts: unknown[] = [];
const scheduled: Array<() => Promise<unknown>> = [];
const dispatched: string[][] = [];

const security = requireModule(resolve(root, "lib/apiSecurity.ts"));
mock.module(url("lib/apiSecurity.ts"), { namedExports: { ...security, consumeApiRateLimit: async () => undefined } });
mock.module(url("lib/chatRouteSession.ts"), {
  namedExports: { resolveChatRouteSession: async () => ({ session: signedIn ? { user: owner } : null }) },
});
mock.module(url("lib/appSettings.ts"), {
  namedExports: {
    ...requireModule(resolve(root, "lib/appSettings.ts")),
    isImageGenerationEnabledCached: async () => globalGate,
  },
});
mock.module(url("lib/modelCatalog.ts"), {
  namedExports: {
    ...requireModule(resolve(root, "lib/modelCatalog.ts")),
    refreshImageModelCatalog: async () => undefined,
  },
});
mock.module(url("lib/prisma.ts"), {
  namedExports: {
    prisma: { imageGenerationGroup: { findUnique: async (query: unknown) => { receipts.push(query); return receipt; } } },
  },
});
mock.module("next/server", {
  namedExports: {
    ...requireModule("next/server"),
    after: (work: () => Promise<unknown>) => scheduled.push(work),
  },
});
mock.module(url("lib/studioImageReference.ts"), {
  namedExports: {
    bindStudioImageUpload: async (_tx: unknown, input: BindInput) => { attachments.push(input); return "owned-attachment"; },
  },
});
mock.module(url("lib/imageGenerationService.ts"), {
  namedExports: {
    requestImageGeneration: async (input: GenerationInput) => {
      reservations.push(input);
      if (input.editSource && "bindAttachment" in input.editSource) {
        await input.editSource.bindAttachment({} as never, "studio-image-conversation");
      }
      // One generation per requested model, as the service answers.
      const targets = (input.modelIds ?? ["default"]).map((modelId, index) => ({
        targetId: "target-" + index, modelId, provider: "test", status: "pending", reservedCredits: 1,
        generationId: index === 0 ? "studio-image" : "studio-image-" + (index + 1),
      }));
      return { generationId: "studio-image", groupId: "studio-group", status: "pending", reused: false, targets };
    },
    processImageGenerationGroup: async (ids: string[]) => { dispatched.push(ids); },
  },
});

const loadRoute = () => import(url("app/api/studio/images/route.ts")) as Promise<typeof import("@/app/api/studio/images/route")>;
const GET = async (request: Request) => (await loadRoute()).GET(request);
const POST = async (request: Request) => (await loadRoute()).POST(request);
const base = "http://127.0.0.1:3100/api/studio/images";
const idempotencyKey = randomUUID();
const quoteRequest = () => new Request(base + "?size=1024x1024&edit=true");
const post = (body: object) => POST(new Request(base, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
const body = {
  idempotencyKey, prompt: "Make a sticker", size: "1024x1024", uploadId: "upload-handle",
  modelId: "gpt-image-2", pricingVersion: "outdated-quote",
};

type QuotedTarget = { modelId: string; model: string; pricingVersion: string; credits: number };
function quotedSubmission(quote: { modelId: string; pricingVersion: string; quality: string; credits: number; size: string; useCase?: string; requestedSize?: string; squareFallback?: boolean; targets?: QuotedTarget[] }) {
  return {
    ...body, modelId: quote.modelId, pricingVersion: quote.pricingVersion, quality: quote.quality,
    credits: quote.credits, size: quote.size, useCase: quote.useCase, requestedSize: quote.requestedSize, squareFallback: quote.squareFallback,
  };
}

beforeEach(() => {
  delete process.env.STUDIO_IMAGE_GENERATION_ENABLED;
  process.env.STUDIO_ENABLED = "true";
  process.env.IMAGE_EDIT_ENABLED = "true";
  signedIn = true;
  globalGate = true;
  receipt = null;
  reservations.length = 0;
  attachments.length = 0;
  receipts.length = 0;
  scheduled.length = 0;
  dispatched.length = 0;
});

test("Studio image generation fails closed before receipt lookup or reservation", async () => {
  assert.equal((await GET(quoteRequest())).status, 503);
  assert.equal((await post(body)).status, 503);
  assert.equal(receipts.length, 0);
  assert.equal(reservations.length, 0);

  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  globalGate = false;
  assert.equal((await GET(quoteRequest())).status, 503);
  signedIn = false;
  assert.equal((await GET(quoteRequest())).status, 401);
  assert.equal((await post(body)).status, 401);
  assert.equal(receipts.length, 0);
  assert.equal(reservations.length, 0);
});

test("receipt replay is owner-scoped and still works after a quote change", async () => {
  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  receipt = { id: "original-group" };
  const response = await post(body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { groupId: "original-group" });
  assert.deepEqual(receipts, [{
    where: { userId_groupIdempotencyKey: { userId: owner.id, groupIdempotencyKey: idempotencyKey } }, select: { id: true },
  }]);
  assert.equal(reservations.length + scheduled.length, 0);

  receipt = null;
  assert.equal((await post(body)).status, 409);
  assert.equal(reservations.length + scheduled.length, 0);
});

test("a fresh quoted edit binds the authenticated upload through the transaction and dispatches once", async () => {
  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  const quoted = await GET(quoteRequest());
  assert.equal(quoted.status, 200);
  const quote = await quoted.json();
  assert.ok(quote.credits > 0);
  const accepted = await post(quotedSubmission(quote));
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { groupId: "studio-group" });
  assert.equal(reservations.length, 1);
  assert.deepEqual(reservations[0].expectedPricingVersions, { [quote.modelId]: quote.pricingVersion });
  assert.equal(reservations[0].idempotencyKey, idempotencyKey);
  assert.deepEqual(attachments, [{
    userId: owner.id, email: owner.email, uploadId: "upload-handle",
    conversationId: "studio-image-conversation", prompt: "Make a sticker",
  }]);
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.deepEqual(dispatched, [["studio-image"]]);
  assert.equal((await post({ ...body, attachmentId: "must-not-be-trusted" })).status, 400);
  assert.equal(reservations.length, 1);
});

test("an open tab can still submit its versioned Medium quote", async () => {
  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  const quote = await (await GET(quoteRequest())).json();
  const result = await post({ ...body, modelId: quote.modelId, pricingVersion: quote.pricingVersion });
  assert.equal(result.status, 202);
  assert.equal(reservations[0].quality, "medium");
  assert.equal((await post({ ...quotedSubmission(quote), quality: undefined })).status, 409);
});

test("Studio automatically routes a feature to a quoted catalogue model and rejects an outdated route", async (context) => {
  const routingEnv = "STUDIO_IMAGE_ROUTE_PREFERENCES";
  const registry = requireModule(resolve(root, "lib/imageModelRegistry.ts"));
  context.after(() => {
    delete process.env[routingEnv];
    registry.resetActiveImageModelCatalog();
  });
  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  const originalModels = registry.listEnabledImageModels();
  const squareEditModels = originalModels.filter((model: typeof originalModels[number]) => {
    const price = registry.getImageModelPrice(model.id, "medium", "1024x1024");
    return price && registry.imageEditCredits(model, price) !== null;
  });
  const primary = squareEditModels.find((model: { id: string }) => model.id === registry.DEFAULT_IMAGE_MODEL_ID);
  const alternate = squareEditModels.find((model: { id: string }) => model.id !== primary?.id);
  assert.ok(primary && alternate);
  process.env[routingEnv] = JSON.stringify({
    "illustration": ["missing-model", alternate.id],
    "live-action-character": "invalid configuration for a different feature",
  });

  const requested = new Request(base + "?size=1024x1024&edit=true&useCase=illustration");
  const quote = await (await GET(requested)).json();
  assert.equal(quote.useCase, "illustration");
  assert.equal(quote.modelId, alternate.id);
  assert.equal((await (await GET(quoteRequest())).json()).modelId, primary.id);
  assert.equal((await GET(new Request(requested.url.replace("illustration", "invalid")))).status, 400);
  assert.equal((await post(quotedSubmission(quote))).status, 202);
  assert.deepEqual(reservations[0].modelIds, [alternate.id]);

  registry.setActiveImageModelCatalog(originalModels.map((model: typeof originalModels[number]) =>
    model.id === alternate.id ? { ...model, disabledReason: "price_unverified" } : model
  ));
  assert.equal((await (await GET(requested)).json()).modelId, primary.id);
  assert.equal((await post(quotedSubmission(quote))).status, 409);
  assert.equal(reservations.length, 1);
});

test("a preferred feature route can choose a square-only model before a landscape fallback", async context => {
  const registry = requireModule(resolve(root, "lib/imageModelRegistry.ts"));
  context.after(() => { delete process.env.STUDIO_IMAGE_ROUTE_PREFERENCES; });
  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  const grok = registry.getImageModel("grok-imagine-image-quality-20260403");
  assert.ok(grok);
  process.env.STUDIO_IMAGE_ROUTE_PREFERENCES = JSON.stringify({ poster: [grok.id] });
  const preferred = new Request(base + "?size=1536x1024&edit=true&useCase=poster&squareFallback=true");
  const quote = await (await GET(preferred)).json();
  assert.equal(quote.modelId, grok.id);
  assert.equal(quote.size, "1024x1024");
  const response = await post(quotedSubmission(quote));
  assert.equal(response.status, 202);
  assert.equal(reservations[0].size, quote.size);
  assert.equal(reservations[0].quality, quote.quality);
});

test("both sticker styles require the square Sunburst edit for packs and replacements", async context => {
  const registry = requireModule(resolve(root, "lib/imageModelRegistry.ts"));
  const id = "gpt-image-2.6-sunburst";
  const other = registry.getImageModel("gpt-image-2");
  const models = registry.listEnabledImageModels();
  context.after(() => {
    delete process.env.STUDIO_IMAGE_ROUTE_PREFERENCES;
    delete process.env.IMAGE_OPENAI_2_6_EDIT_ENABLED;
    registry.resetActiveImageModelCatalog();
  });
  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  process.env.IMAGE_OPENAI_2_6_EDIT_ENABLED = "true";
  process.env.STUDIO_IMAGE_ROUTE_PREFERENCES = JSON.stringify({
    "real-sticker-pack": [other.id], "real-sticker": [other.id],
    "character-sticker-pack": [other.id], "character-sticker": [other.id],
  });
  const price = { ...registry.getImageModelPrice(other.id, "medium", "1024x1024"), credits: 65, outputCostMicroUsd: 43_470 };
  registry.setActiveImageModelCatalog([...models.filter((m: { id: string }) => m.id !== id), {
    ...other, id, apiModelId: id, prices: [price],
  }]);
  const square = base + "?size=1024x1024&edit=true&useCase=";
  const legacy = base + "?size=1536x1024&edit=true&squareFallback=true&useCase=";
  const urls = [square + "real-sticker-pack", square + "real-sticker", square + "character-sticker-pack",
    square + "character-sticker", legacy + "real-sticker-pack", legacy + "character-sticker-pack"];
  for (const url of urls) {
    const response = await GET(new Request(url));
    assert.equal(response.status, 200);
    const quote = await response.json();
    assert.deepEqual([quote.modelId, quote.size, quote.quality, quote.credits], [id, "1024x1024", "medium", 65]);
    assert.equal((await post(quotedSubmission(quote))).status, 202);
    assert.deepEqual(reservations.at(-1)?.modelIds, [id]);
  }
  const request = new Request(square + "character-sticker-pack");
  const submission = quotedSubmission(await (await GET(request)).json());
  assert.equal((await post({ ...submission, modelId: other.id })).status, 409);
  assert.equal((await post({ ...submission, uploadId: undefined })).status, 409);
  assert.equal((await GET(new Request(request.url.replace("edit=true", "edit=false")))).status, 503);
  process.env.IMAGE_OPENAI_2_6_EDIT_ENABLED = "false";
  assert.equal((await GET(request)).status, 503);
  assert.equal((await post(submission)).status, 409);
  assert.equal(reservations.length, urls.length);
});

test("a transparent PNG is quoted on every background remover that is on, each submitted as its own request", async context => {
  const switches = ["IMAGE_RECRAFT_BACKGROUND_REMOVAL_ENABLED", "IMAGE_FAL_BRIA_BACKGROUND_REMOVAL_ENABLED"];
  context.after(() => {
    for (const name of [...switches, "STUDIO_IMAGE_ROUTE_PREFERENCES"]) delete process.env[name];
  });
  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  // A route preference cannot put an image generator in a remover's place.
  process.env.STUDIO_IMAGE_ROUTE_PREFERENCES = JSON.stringify({ "transparent-png": ["gpt-image-2"] });
  const request = new Request(base + "?size=1024x1024&edit=true&useCase=transparent-png");
  assert.equal((await GET(request)).status, 503);

  // One switch: that remover alone.
  process.env[switches[0]] = "true";
  const single = await (await GET(request)).json();
  assert.deepEqual([single.modelId, single.credits, single.targets.map((target: QuotedTarget) => target.modelId)],
    ["recraft-remove-background", 20, ["recraft-remove-background"]]);

  // Both: two tools, each with its own price, and their total.
  process.env[switches[1]] = "true";
  const quote = await (await GET(request)).json();
  assert.deepEqual([quote.size, quote.quality, quote.credits, quote.useCase], ["1024x1024", "medium", 46, "transparent-png"]);
  assert.deepEqual(quote.targets.map((target: QuotedTarget) => [target.modelId, target.credits]),
    [["recraft-remove-background", 20], ["bria/rmbg-3", 26]]);
  assert.equal((await GET(new Request(request.url.replace("edit=true", "edit=false")))).status, 503);
  assert.equal((await GET(new Request(request.url.replace("1024x1024", "1536x1024")))).status, 503);
  // No other feature is offered a tool.
  const other = await (await GET(quoteRequest())).json();
  assert.ok(!["recraft-remove-background", "bria/rmbg-3"].includes(other.modelId) && other.targets === undefined);

  // One request per tool, at that tool's own price: never the total, another tool's price or a model that was not quoted.
  const [recraft, bria] = (quote.targets as QuotedTarget[]).map(target => ({
    ...quotedSubmission({ ...quote, ...target }), targets: undefined, idempotencyKey: randomUUID(),
  }));
  for (const wrong of [
    { ...recraft, credits: 46 }, { ...bria, credits: 20 }, { ...bria, pricingVersion: recraft.pricingVersion },
    { ...recraft, modelId: "gpt-image-2" }, { ...recraft, size: "1536x1024" }, { ...recraft, quality: "high" },
  ]) {
    assert.equal((await post({ ...wrong, idempotencyKey: randomUUID() })).status, 409, JSON.stringify(wrong));
  }
  assert.equal(reservations.length, 0);
  assert.equal((await post(recraft)).status, 202);
  assert.equal((await post(bria)).status, 202);
  assert.deepEqual(reservations.map(row => [row.modelIds, row.photoTools]),
    [[["recraft-remove-background"], ["recraft-remove-background"]], [["bria/rmbg-3"], ["bria/rmbg-3"]]]);
  // Each request starts its own generation.
  assert.equal(scheduled.length, 2);
  // A tool's id cannot ride on another feature's quote, and another feature never names a tool.
  assert.equal((await post({ ...quotedSubmission(other), modelId: "bria/rmbg-3", idempotencyKey: randomUUID() })).status, 409);
  assert.equal((await post({ ...quotedSubmission(other), idempotencyKey: randomUUID() })).status, 202);
  assert.equal(reservations[2].photoTools, undefined);
  // Each tool stops with its own switch; the other keeps working.
  process.env[switches[1]] = "false";
  assert.equal((await post({ ...bria, idempotencyKey: randomUUID() })).status, 409);
  assert.equal((await post({ ...recraft, idempotencyKey: randomUUID() })).status, 202);
});

test("Studio reserves exactly the quoted model, quality, size and credit amount", async context => {
  const registry = requireModule(resolve(root, "lib/imageModelRegistry.ts"));
  context.after(() => {
    registry.resetActiveImageModelCatalog();
    delete process.env.STUDIO_IMAGE_ROUTE_PREFERENCES;
    delete process.env.IMAGE_RECRAFT_EDIT_ENABLED;
  });
  process.env.STUDIO_IMAGE_GENERATION_ENABLED = "true";
  process.env.STUDIO_IMAGE_ROUTE_PREFERENCES = JSON.stringify({ "live-action-character": ["recraftv4_pro"] });
  const requested = new Request(base + "?size=1024x1024&edit=true&useCase=live-action-character");
  assert.notEqual((await (await GET(requested)).json()).modelId, "recraftv4_pro");
  process.env.IMAGE_RECRAFT_EDIT_ENABLED = "true";
  const quote = await (await GET(requested)).json();
  assert.equal(quote.modelId, "recraftv4_pro");
  assert.equal(quote.size, "2048x2048");
  assert.equal(quote.requestedSize, "1024x1024");
  assert.equal(quote.credits, 350);
  const submit = quotedSubmission(quote);
  for (const mismatch of [{ credits: 349 }, { quality: "high" }, { size: "1024x1024" }]) {
    assert.equal((await post({ ...submit, ...mismatch })).status, 409);
  }
  assert.equal(reservations.length, 0);
  // Another preferred model can serve the output size but not the requested shape.
  const models = registry.listEnabledImageModels();
  const first = models.find((model: { id: string }) => model.id === "gpt-image-2");
  registry.setActiveImageModelCatalog(models.map((model: typeof first) => model.id === first.id ? {
    ...model, prices: [{ ...model.prices[0], size: "2048x2048", quality: "medium" }],
  } : model));
  process.env.STUDIO_IMAGE_ROUTE_PREFERENCES = JSON.stringify({ "live-action-character": [first.id, "recraftv4_pro"] });
  assert.equal((await (await GET(new Request(base + "?size=2048x2048&edit=true&useCase=live-action-character"))).json()).modelId, first.id);
  assert.equal((await post(submit)).status, 202);
  assert.equal(reservations[0].size, "2048x2048");
  assert.equal(reservations[0].quality, "medium");
});
