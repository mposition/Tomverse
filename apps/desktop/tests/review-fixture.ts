import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { prisma } from "../../../lib/prisma";

const imageFixture = {
  id: "desktop-image-fixture", name: "Fixture Image", provider: "openai", pricingVersion: "v1",
  prices: [{ size: "1024x1024", quality: "medium", credits: 2 }],
};
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZbkAAAAASUVORK5CYII=";
type ReviewDispatch = { conversationId: string; modelId: string; assistantMessageId: string; sourceUserMessageId: string; admissionToken?: string };

export async function installReviewCapabilities(application: ElectronApplication, origin: string) {
  await application.evaluate((_electron, fixture) => {
    const fetchReal = globalThis.fetch;
    globalThis.fetch = async (target, init) => {
      const response = await fetchReal(target, init);
      const url = new URL(String(target));
      if (url.origin !== fixture.origin || url.pathname !== "/api/products/chat/capabilities" || !response.ok) return response;
      return Response.json({ ...(await response.json()), desktopImages: { maxModels: 3, models: [fixture.image] } });
    };
  }, { origin, image: imageFixture });
}

export async function verifyReviewAndImages(application: ElectronApplication, desktop: Page, context: {
  origin: string; profile: string; email: string;
}) {
  const imageConversation = "image-" + randomUUID();
  const groupId = "group-" + randomUUID();
  const generationId = "generation-" + randomUUID();
  const targetId = "target-" + randomUUID();
  const imageFile = join(context.profile, "saved-image.png");
  const imagePrompt = "Local image comparison fixture";
  const modelIds = ["gpt-6-luna", "gpt-5-6-luna"];
  const question = "Compare the fixture answers " + randomUUID();
  const fixtureImage = {
    conversationId: imageConversation, generationId, groupId, targetId, modelId: imageFixture.id, attemptNumber: 1,
    prompt: imagePrompt, status: "pending", createdAt: new Date().toISOString(), publicErrorCode: null, refunded: false,
  };
  const user = await prisma.user.findUniqueOrThrow({ where: { email: context.email } });
  let reviewId: string | undefined;
  try {
    await application.evaluate(({ dialog }, config) => {
      const host = globalThis as typeof globalThis & {
        reviewDispatches: ReviewDispatch[]; reviewFinish: Array<() => void>;
        reviewPreflights: string[][]; imagePosts: number; receiptReads: number;
        generatedImage?: { idempotencyKey: string; modelIds: string[]; expectedPricingVersions: Record<string, string> };
        firstImageRequestKey?: string;
      };
      const realFetch = globalThis.fetch;
      host.reviewDispatches = [];
      host.reviewFinish = [];
      host.reviewPreflights = [];
      host.imagePosts = 0;
      host.receiptReads = 0;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: config.imageFile });
      globalThis.fetch = async (target, init) => {
        const url = String(target);
        if (host.imagePosts && url.split("?")[0] === config.origin + "/api/products/chat/capabilities") {
          const response = await realFetch(target, init);
          if (!response.ok) return response;
          const capabilities = await response.json();
          return Response.json({
            ...capabilities,
            desktopImages: {
              ...capabilities.desktopImages,
              models: [{ ...config.imageModel, pricingVersion: "v2", prices: [{ ...config.imageModel.prices[0], credits: 3 }] }],
            },
          });
        }
        if (url === config.origin + "/api/chat/preflight" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          host.reviewPreflights.push(body.modelIds);
          return Response.json({ ok: true, admissionToken: "local-comparison-fixture", contextBundle: null });
        }
        if (url === config.origin + "/api/chat" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          host.reviewDispatches.push(body);
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("Response from " + body.modelId));
              host.reviewFinish.push(() => controller.close());
            },
          }), { headers: { "Content-Type": "text/plain" } });
        }
        if (url === config.origin + "/api/review/route" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          return Response.json({ kind: "image", preset: "standard",
            choices: body.providers.map((provider: string) => ({ provider, modelId: provider === "openai" ? config.image.modelId : null })) });
        }
        if (url === config.origin + "/api/images/generations" && init?.method === "POST") {
          host.generatedImage = JSON.parse(String(init.body));
          host.imagePosts++;
          if (host.imagePosts === 1) {
            host.firstImageRequestKey = host.generatedImage!.idempotencyKey;
            return Response.json({ code: "IMAGE_PRICE_CHANGED" }, { status: 409 });
          }
          throw new TypeError("Fixture lost the image request response");
        }
        if (host.generatedImage && url === config.origin + "/api/images/generations?requestKey=" + host.generatedImage.idempotencyKey) {
          host.receiptReads++;
          if (host.imagePosts === 1) return Response.json({ code: "IMAGE_REQUEST_NOT_FOUND" }, { status: 404 });
          return Response.json({ conversationId: config.image.conversationId, groupId: config.image.groupId });
        }
        if (url === config.origin + `/api/conversations/${config.image.conversationId}/generations`) {
          return Response.json({ conversationId: config.image.conversationId, generations: [config.image] });
        }
        if (url === config.origin + `/api/images/groups/${config.image.groupId}`) {
          return Response.json({ groupId: config.image.groupId, conversationId: config.image.conversationId, status: "succeeded",
            targets: [{ targetId: config.image.targetId, currentGenerationId: config.image.generationId }],
            generations: [{ ...config.image, status: "succeeded" }] });
        }
        const asset = config.origin + `/api/images/generations/${config.image.generationId}/download`;
        if (url === asset || url === asset + "?preview=1") {
          const bytes = Buffer.from(config.pixel, "base64");
          return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) } });
        }
        return realFetch(target, init);
      };
    }, { origin: context.origin, imageFile, image: fixtureImage, imageModel: imageFixture, pixel });

    await desktop.getByRole("button", { name: "Review", exact: true }).click();
    await desktop.getByLabel("Review mode and models").click();
    await desktop.getByRole("combobox", { name: "Mode" }).selectOption("professional");
    await desktop.getByRole("checkbox", { name: "GPT 6 Luna", exact: true }).check();
    await desktop.getByRole("checkbox", { name: "GPT-5.6 Luna", exact: true }).check();
    await desktop.getByLabel("Review mode and models").click();
    await desktop.getByRole("textbox", { name: "Review question" }).fill(question);
    await desktop.getByRole("button", { name: "Send Review question" }).click();
    await expect(desktop.getByText("Response from gpt-6-luna", { exact: true })).toBeVisible();
    await expect(desktop.getByText("Response from gpt-5-6-luna", { exact: true })).toBeVisible();
    const [preflight, dispatches] = await application.evaluate(() => {
      const host = globalThis as typeof globalThis & { reviewDispatches: ReviewDispatch[]; reviewPreflights: string[][] };
      return [host.reviewPreflights, host.reviewDispatches] as const;
    });
    assert.deepEqual(preflight, [modelIds]);
    const [first] = dispatches;
    assert.ok(first);
    reviewId = first.conversationId;
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: reviewId } })).productKey, "review");
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: first.sourceUserMessageId } })).content, question);
    for (const dispatch of dispatches) {
      assert.equal(dispatch.admissionToken, "local-comparison-fixture");
      await prisma.message.create({ data: { id: dispatch.assistantMessageId, conversationId: reviewId, role: "assistant",
        status: "normal", content: "Saved response from " + dispatch.modelId, modelId: dispatch.modelId } });
    }
    await application.evaluate(() => (globalThis as typeof globalThis & { reviewFinish: Array<() => void> }).reviewFinish.forEach((finish) => finish()));
    await expect(desktop.getByText("Saved response from gpt-6-luna", { exact: true })).toBeVisible();
    await desktop.getByRole("button", { name: "Continue in Chat", exact: true }).first().click();
    await expect(desktop.getByRole("textbox", { name: "Chat message" })).toHaveValue(new RegExp(question));

    await desktop.getByRole("button", { name: "Image workspace", exact: true }).click();
    await expect(desktop.getByRole("heading", { name: "Generate and compare images" })).toBeVisible();
    await desktop.getByRole("button", { name: "Review", exact: true }).click();
    await desktop.getByRole("button", { name: question, exact: true }).click();
    await expect(desktop.getByText("Saved response from gpt-5-6-luna", { exact: true })).toBeVisible();
    await desktop.getByRole("button", { name: "New review", exact: true }).click();
    await desktop.getByLabel("Review mode and models").click();
    await desktop.getByRole("combobox", { name: "Mode" }).selectOption("easy");
    await desktop.getByRole("checkbox", { name: "openai", exact: true }).check();
    await desktop.getByLabel("Review mode and models").click();
    await desktop.getByRole("textbox", { name: "Review question" }).fill(imagePrompt);
    await desktop.getByRole("button", { name: "Send Review question" }).click();
    await desktop.getByRole("button", { name: "Review image options" }).click();
    assert.equal(await prisma.conversation.count({ where: { userId: user.id, kind: "image" } }), 0);
    assert.equal(await application.evaluate(() =>
      (globalThis as typeof globalThis & { generatedImage?: object }).generatedImage === undefined), true);
    await expect(desktop.getByRole("textbox", { name: "Image description" })).toHaveValue(imagePrompt);
    await desktop.getByLabel("Image model picker").click();
    await expect(desktop.getByRole("checkbox", { name: "Fixture Image · 2 credits" })).toBeChecked();
    await desktop.getByLabel("Image model picker").click();
    await desktop.getByRole("button", { name: "Generate · 2 credits" }).click();
    await expect(desktop.getByText("The image price changed. Review the current quote before generating.")).toBeVisible();
    await expect(desktop.getByRole("textbox", { name: "Image description" })).toHaveValue(imagePrompt);
    assert.equal(await application.evaluate(() => (globalThis as typeof globalThis & { imagePosts: number }).imagePosts), 1);
    await desktop.getByRole("button", { name: "Generate · 3 credits" }).click();
    await expect(desktop.getByRole("img", { name: imagePrompt })).toBeVisible({ timeout: 15_000 });
    const generated = await application.evaluate(() => {
      const host = globalThis as typeof globalThis & {
        firstImageRequestKey: string;
        generatedImage: { idempotencyKey: string; modelIds: string[]; expectedPricingVersions: Record<string, string> };
      };
      return { firstKey: host.firstImageRequestKey, ...host.generatedImage };
    });
    assert.deepEqual(generated.modelIds, [imageFixture.id]);
    assert.deepEqual(generated.expectedPricingVersions, { [imageFixture.id]: "v2" });
    assert.equal(generated.idempotencyKey, generated.firstKey);
    await desktop.getByRole("button", { name: "Save image" }).click();
    await expect(desktop.getByText("Image saved.")).toBeVisible();
    assert.deepEqual(await readFile(imageFile), Buffer.from(pixel, "base64"));
    assert.deepEqual(await application.evaluate(() => {
      const host = globalThis as typeof globalThis & { imagePosts: number; receiptReads: number };
      return [host.imagePosts, host.receiptReads];
    }), [2, 2]);
    await desktop.getByRole("button", { name: "Save image" }).click();
    await expect(desktop.getByText("Could not save the image. Choose a new file name and try again.")).toBeVisible();
    assert.deepEqual(await readFile(imageFile), Buffer.from(pixel, "base64"));
  } finally {
    if (reviewId) await prisma.conversation.deleteMany({ where: { id: reviewId } });
    await prisma.$disconnect();
  }
}
