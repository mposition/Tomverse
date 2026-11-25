import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const origin = process.env.DESKTOP_E2E_AUTH_ORIGIN;

test("Desktop Review handles legacy writes, continuation history, and capped image offers", { timeout: 60_000, skip: !origin }, async (t) => {
  assert.ok(origin);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d{4,5}$/);
  const profile = await mkdtemp(join(tmpdir(), "tomverse-review-followups-"));
  const review = { id: "continued-review", title: "Continued Review fixture", kind: "chat", surface: "continuation", productKey: "review" };
  const legacy = { id: "legacy-review", title: "Read-only legacy Review", kind: "chat", surface: "workspace", productKey: null };
  const providers = ["openai", "anthropic", "google"];
  let app: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    app = await electron.launch({ executablePath, args: [desktopDir, "--user-data-dir=" + profile], timeout: 20_000 });
    await app.evaluate(({ shell }, fixture) => {
      const host = globalThis as typeof globalThis & {
        imagePosts: Array<{ modelIds: string[]; expectedPricingVersions: Record<string, string> }>;
        sourceOffsets: string[];
        imageOffers: string[][];
        legacyWritable: boolean;
        legacyModels: string[];
        savedPrompt?: { id: string; content: string; role: string; createdAt: string };
        legacyAnswers: Array<{ id: string; content: string; role: string; modelId: string; status: string; createdAt: string }>;
        legacyCalls: string[];
      };
      host.imagePosts = [];
      host.sourceOffsets = [];
      host.imageOffers = [];
      host.legacyWritable = true;
      host.legacyModels = [];
      host.legacyAnswers = [];
      host.legacyCalls = [];
      const realFetch = globalThis.fetch;
      shell.openExternal = async (href) => {
        const target = new URL(href);
        if (target.origin !== fixture.origin || target.pathname !== "/auth/desktop") throw new Error("Unexpected browser destination.");
        const callback = new URL(target.searchParams.get("redirect_uri")!);
        if (callback.hostname !== "127.0.0.1" || callback.pathname !== "/desktop-login/callback") {
          throw new Error("Unexpected fixture callback.");
        }
        callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the fixture account.");
      };
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== fixture.origin) return new Response(null, { status: 404 });
        const models = fixture.providers.map((provider) => ({ id: provider + "-image", name: provider + " Image", provider,
          pricingVersion: "v1", prices: [{ size: "1024x1024", quality: "medium", credits: 2 }] }));
        if (url.pathname === "/api/auth/desktop/exchange") {
          return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        }
        if (url.pathname === "/api/auth/desktop/session") {
          return Response.json({ ok: true, account: { id: "review-fixture", name: "Review Fixture", email: "review@example.test" } });
        }
        if (url.pathname === "/api/products/chat/capabilities") {
          return Response.json({ autoSelection: { offered: false }, desktopReview: { easy: true, modelLimit: 3, plan: "Max" },
            desktopImages: { maxModels: 2, models } });
        }
        if (url.pathname === "/api/models/catalog") {
          return Response.json({ models: fixture.providers.map((provider) => ({ id: provider + "-text", name: provider,
            provider, minimumPlan: "Free", publiclyListed: true, status: "enabled", enabled: true })) });
        }
        if (url.pathname === "/api/conversations") return Response.json([fixture.review, fixture.legacy]);
        const legacyPath = "/api/conversations/" + fixture.legacy.id;
        if (url.pathname === legacyPath && init?.method === "PATCH") {
          host.legacyCalls.push("configure");
          host.legacyModels = JSON.parse(String(init.body)).selectedModels;
          return Response.json({ id: fixture.legacy.id });
        }
        if (url.pathname === "/api/chat/preflight") {
          host.legacyCalls.push("preflight");
          return Response.json({ ok: true, admissionToken: "legacy-comparison", contextBundle: null });
        }
        if (url.pathname === legacyPath + "/messages") {
          host.legacyCalls.push("save");
          const { clientRequestId, content } = JSON.parse(String(init?.body)).messages[0];
          host.savedPrompt = { id: "saved-legacy-question", content, role: "user", createdAt: new Date(1).toISOString() };
          return Response.json({ messageMappings: [{ requestId: clientRequestId, messageId: host.savedPrompt.id }] });
        }
        if (url.pathname === "/api/chat") {
          const { modelId, assistantMessageId, conversationId, sourceUserMessageId, admissionToken } = JSON.parse(String(init?.body));
          if (conversationId !== fixture.legacy.id || sourceUserMessageId !== host.savedPrompt?.id ||
              admissionToken !== "legacy-comparison") return new Response(null, { status: 400 });
          host.legacyCalls.push(modelId);
          const reply = "Follow-up answer from " + modelId;
          host.legacyAnswers.push({ id: assistantMessageId, content: reply, role: "assistant", modelId, status: "normal", createdAt: new Date(2 + host.legacyAnswers.length).toISOString() });
          return new Response(reply);
        }
        for (const conversation of [fixture.review, fixture.legacy]) {
          if (url.pathname !== "/api/conversations/" + conversation.id) continue;
          const isLegacy = conversation.productKey === null;
          const previous = { id: "native-question", content: "Tomverse follow-up question", role: "user", createdAt: new Date(0).toISOString() };
          const messages = isLegacy && host.savedPrompt ? [previous, host.savedPrompt, ...host.legacyAnswers] : [previous];
          return Response.json({ ...conversation, ...(isLegacy ? { desktopReviewWritable: host.legacyWritable } : {}),
            messages, selectedModels: isLegacy ? host.legacyModels : [], messagePage: { nextCursor: null },
            selectionMode: "manual", autoSelection: { offered: false } });
        }
        if (url.pathname === "/api/conversations/" + fixture.review.id + "/continuation") {
          const offset = url.searchParams.get("offset") ?? "";
          host.sourceOffsets.push(offset);
          return Response.json({ provider: "chatgpt", source: { status: "available", messageTotal: 51,
            offset: offset === "end" ? 50 : 0, messages: offset === "end"
              ? [{ id: "imported-new", content: "Latest imported answer", role: "assistant" }]
              : [{ id: "imported-old", content: "Earlier imported question", role: "user" }] } });
        }
        if (url.pathname === "/api/review/route" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { providers: string[] };
          host.imageOffers.push(body.providers);
          return Response.json({ kind: "image", preset: "standard",
            choices: body.providers.map((provider) => ({ provider, modelId: provider + "-image" })) });
        }
        if (url.pathname === "/api/images/generations" && init?.method === "POST") {
          host.imagePosts.push(JSON.parse(String(init.body)));
          return Response.json({ conversationId: "image-comparison", groupId: "image-group" });
        }
        if (url.pathname === "/api/conversations/image-comparison/generations") {
          return Response.json({ conversationId: "image-comparison", generations: [] });
        }
        return new Response(null, { status: 404 });
      };
    }, { origin, review, legacy, providers });
    const desktop = await app.firstWindow();
    await desktop.getByRole("button", { name: "Settings", exact: true }).click();
    await desktop.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(() => desktop.evaluate(async () => (await window.desktop.state()).account))
      .toMatchObject({ stage: "connected", label: "review@example.test" });
    await desktop.getByRole("button", { name: "Review", exact: true }).click();
    await expect(desktop.getByRole("heading", { name: /Three perspectives/ })).toBeVisible();
    await expect(desktop.getByLabel("New chat options")).toHaveCount(0);
    await desktop.getByRole("button", { name: "New review", exact: true }).click();
    await expect(desktop.getByRole("textbox", { name: "Review question" })).toBeFocused();

    await t.test("Review shows the imported source before the native thread and loads earlier messages", async () => {
      await desktop.getByRole("button", { name: review.title, exact: true }).click();
      const imported = desktop.getByRole("region", { name: "Imported conversation", exact: true });
      await expect(imported.getByText("Latest imported answer")).toBeVisible();
      await expect(desktop.getByRole("heading", { name: "Tomverse follow-up question" })).toBeVisible();
      assert.ok(await imported.evaluate((section) => !!section.nextElementSibling?.matches(".review-turn")));
      await imported.getByRole("button", { name: "Load earlier imported messages" }).click();
      await expect(imported.getByText("Earlier imported question")).toBeVisible();
      await expect(imported.getByText("Latest imported answer")).toBeVisible();
      assert.deepEqual(await app!.evaluate(() =>
        (globalThis as typeof globalThis & { sourceOffsets: string[] }).sourceOffsets), ["end", "0"]);
    });

    await t.test("Legacy Review continues with two models and respects a later read-only decision", async () => {
      const row = desktop.getByRole("button", { name: legacy.title, exact: true });
      await row.click();
      const modes = desktop.getByLabel("Review mode and models");
      await modes.click();
      await desktop.getByRole("combobox", { name: "Mode" }).selectOption("professional");
      for (const provider of providers.slice(0, 2)) await desktop.getByRole("checkbox", { name: provider, exact: true }).check();
      await modes.click();
      const prompt = "Continue my previous Review";
      await desktop.getByRole("textbox", { name: "Review question" }).fill(prompt);
      await desktop.getByRole("button", { name: "Send Review question" }).click();
      await expect(desktop.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
      await expect(desktop.getByText("Follow-up answer from openai-text", { exact: true })).toBeVisible();
      await expect(desktop.getByText("Follow-up answer from anthropic-text", { exact: true })).toBeVisible();
      assert.deepEqual(await app!.evaluate(() => {
        const host = globalThis as typeof globalThis & { legacyWritable: boolean; legacyCalls: string[] };
        host.legacyWritable = false;
        return [...host.legacyCalls.slice(0, 3), ...host.legacyCalls.slice(3).sort()];
      }), ["configure", "preflight", "save", "anthropic-text", "openai-text"]);
      await desktop.getByRole("button", { name: "New review", exact: true }).click();
      await row.click();
      await expect(desktop.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
      await expect(desktop.getByText("Sending is unavailable in this environment.", { exact: true })).toBeVisible();
      await expect(desktop.getByRole("textbox", { name: "Review question" })).toHaveCount(0);
      await expect(desktop.getByRole("region", { name: "Imported conversation" })).toHaveCount(0);
    });

    await t.test("The image quote and generation use at most two of the three suggested models", async () => {
      await desktop.getByRole("button", { name: "New review", exact: true }).click();
      await desktop.getByLabel("Review mode and models").click();
      await desktop.getByRole("combobox", { name: "Mode" }).selectOption("easy");
      for (const provider of providers) await desktop.getByRole("checkbox", { name: provider, exact: true }).check();
      await desktop.getByLabel("Review mode and models").click();
      await desktop.getByRole("textbox", { name: "Review question" }).fill("Draw three city skylines");
      await desktop.getByRole("button", { name: "Send Review question" }).click();
      await desktop.getByRole("button", { name: "Review image options" }).click();
      const evidence = () => app!.evaluate(() => {
        const host = globalThis as typeof globalThis & { imageOffers: string[][]; imagePosts: object[] };
        return { offers: host.imageOffers, posts: host.imagePosts };
      });
      assert.deepEqual(await evidence(), { offers: [providers], posts: [] });
      await desktop.getByLabel("Image model picker").click();
      const first = desktop.getByRole("checkbox", { name: "openai Image · 2 credits" });
      const second = desktop.getByRole("checkbox", { name: "anthropic Image · 2 credits" });
      const third = desktop.getByRole("checkbox", { name: "google Image · 2 credits" });
      await expect(first).toBeChecked();
      await expect(second).toBeChecked();
      await expect(third).not.toBeChecked();
      await expect(third).toBeDisabled();
      await first.uncheck();
      await third.check();
      await desktop.getByLabel("Image model picker").click();
      await desktop.getByRole("button", { name: "Generate · 4 credits" }).click();
      await expect.poll(async () => (await evidence()).posts).toMatchObject([{
        modelIds: ["anthropic-image", "google-image"], expectedPricingVersions: { "anthropic-image": "v1", "google-image": "v1" },
      }]);
    });
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
