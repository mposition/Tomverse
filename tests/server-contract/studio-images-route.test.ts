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
      return { generationId: "studio-image", groupId: "studio-group", status: "pending", reused: false };
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
  const accepted = await post({ ...body, modelId: quote.modelId, pricingVersion: quote.pricingVersion });
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
