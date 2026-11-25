import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const require = createRequire(import.meta.url);
const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
const artifacts = process.env.TOMVERSE_DESKTOP_PARITY_QA;

test("Desktop opens the shared model picker, dismisses menus, renders saved images and opens Review analysis", {
  timeout: 75_000, skip: !authOrigin || !artifacts,
}, async () => {
  assert.ok(authOrigin && artifacts);
  const profile = await mkdtemp(join(artifacts, "parity-profile-"));
  await writeFile(join(profile, "language.txt"), "en");
  const app = await electron.launch({ executablePath: require("electron"),
    args: [resolve(fileURLToPath(new URL("../", import.meta.url))), `--user-data-dir=${profile}`], timeout: 20_000 });
  try {
    await app.evaluate(async ({ shell }, origin) => {
      const fetchNetwork = globalThis.fetch;
      shell.openExternal = async (href) => {
        const url = new URL(href);
        if (url.origin !== origin || url.pathname !== "/auth/desktop") throw Error("Unexpected external URL");
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        if (!(await fetchNetwork(callback)).ok) throw Error("Sign-in fixture failed");
      };
      const chat = { id: "chat-fixture", title: "A saved image", kind: "chat", productKey: "chat", surface: "chat", selectedModels: ["gpt-6-luna"] };
      const review = { id: "review-fixture", title: "Two saved answers", kind: "chat", productKey: "review", surface: "workspace", selectedModels: ["gpt-6-luna", "gemini-flash-lite"] };
      const [questionId, firstId, secondId] = ["1", "2", "3"].map((id) => `00000000-0000-4000-8000-${id.padStart(12, "0")}`);
      const preview = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9nO9sAAAAASUVORK5CYII=", "base64");
      const result = { id: "analysis-fixture", responseMap: [
        { responseId: "A", messageId: firstId, modelId: "gpt-6-luna", modelName: "GPT 6 Luna" },
        { responseId: "B", messageId: secondId, modelId: "gemini-flash-lite", modelName: "Gemini Flash-Lite" },
      ], result: { primary: { reviewerModelId: "gpt-6-luna", result: {
        consensus: [], differences: [{ issue: "The approaches differ", positions: [
          { responseId: "A", position: "Start with tests", quote: "Start with tests.", verified: true },
        ] }], contradictions: [], missingPoints: [], verificationNeeded: [], modelAssessments: [], synthesis: "", confidence: "high",
        limitations: [], groundingStats: { totalCitations: 1, verifiedCitations: 1 },
      } }, secondary: null, agreement: null } };
      const host = globalThis as typeof globalThis & { runs: number };
      host.runs = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== origin) throw Error("Unexpected network request");
        const method = init?.method ?? "GET";
        switch (url.pathname) {
          case "/api/auth/desktop/exchange": return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
          case "/api/auth/desktop/session": return Response.json({ ok: true, account: { id: "parity-account", name: "Parity Fixture", email: null } });
          case "/api/products/chat/capabilities": return Response.json({ autoSelection: { offered: true }, desktopWrite: true, desktopAttachments: true,
            desktopReview: { easy: false, modelLimit: 3, plan: "Max" }, desktopReviewAnalysis: true, desktopComposerTools: true, desktopSearchReadiness: { brave: true },
            desktopImages: { maxModels: 2, models: [{ id: "gpt-image-2", name: "GPT Image 2", provider: "openai", pricingVersion: "fixture",
              prices: [{ size: "1024x1024", quality: "medium", credits: 15 }] },
            { id: "recraftv4_pro", name: "Recraft V4 Pro", provider: "recraft", pricingVersion: "fixture-2k",
              prices: [{ size: "2048x2048", quality: "high", credits: 350 }] }] } });
          case "/api/models/catalog": return Response.json({ models: [
            { id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", usageClass: "standard" },
            { id: "gemini-flash-lite", name: "Gemini Flash-Lite", provider: "google", usageClass: "premium-reasoning" },
            { id: "research-fixture", name: "Research model", provider: "perplexity", usageClass: "research" },
            { id: "deep-research-fixture", name: "Deep research model", provider: "perplexity", usageClass: "deep-research" },
            { id: "unrecognized-fixture", name: "Unrecognized model", provider: "openai", usageClass: "unknown-usage-class" },
          ].map((model) => ({ ...model, minimumPlan: "Free", enabled: true, status: "enabled" })) });
          case "/api/conversations": return Response.json([chat, review]);
          case `/api/conversations/${chat.id}`: return Response.json({ ...chat, messagePage: { nextCursor: null }, selectionMode: "auto", autoSelection: { offered: true }, messages: [
            { id: questionId, role: "user", content: "Create a tiny image", status: "normal" },
            { id: firstId, role: "assistant", content: "[Image generated] Create a tiny image", status: "normal", imageTurn: { groupId: "image-group", modelIds: ["gpt-image-2"] } },
          ] });
          case `/api/conversations/${review.id}`: return Response.json({ ...review, messagePage: { nextCursor: null }, selectionMode: "manual", autoSelection: { offered: false }, messages: [
            { id: questionId, role: "user", content: "How should I begin?", status: "normal" },
            { id: firstId, role: "assistant", content: "Start with tests.", modelId: "gpt-6-luna", status: "normal" },
            { id: secondId, role: "assistant", content: "Start with a prototype.", modelId: "gemini-flash-lite", status: "normal" },
          ] });
          case "/api/images/groups/image-group": return Response.json({ conversationId: chat.id, groupId: "image-group", status: "succeeded",
            targets: [{ targetId: "target-1", currentGenerationId: "generated-image" }], generations: [{ generationId: "generated-image", groupId: "image-group",
              targetId: "target-1", modelId: "gpt-image-2", attemptNumber: 1, prompt: "Create a tiny image", status: "succeeded",
              createdAt: new Date().toISOString(), refunded: false, publicErrorCode: null }] });
          case "/api/images/generations/generated-image/download": return new Response(new Uint8Array(preview), { headers: { "content-type": "image/png" } });
          case `/api/conversations/${review.id}/comparison-reviews`: {
            if (method === "POST") {
              const body = JSON.parse(String(init?.body));
              if (body.promptMessageId !== questionId || body.assistantMessageIds?.join() !== [firstId, secondId].join()) return Response.json({}, { status: 400 });
              host.runs++; return Response.json(result);
            }
            return Response.json({ available: true, source: { question: "How should I begin?", responses: [
              { messageId: firstId, content: "Start with tests." }, { messageId: secondId, content: "Start with a prototype." },
            ] }, promptMessageId: questionId, assistantMessageIds: [firstId, secondId] });
          }
          default: return Response.json({}, { status: 404 });
        }
      };
    }, authOrigin);
    const page = await app.firstWindow({ timeout: 12_000 });
    page.setDefaultTimeout(8_000);
    page.on("pageerror", async (error) => { await writeFile(join(artifacts, "renderer-error.txt"), error.stack ?? error.message); });
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).account.stage)).toBe("connected");
    await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: "Chat", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(2100, 920); });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(1600);
    const chatTitle = page.getByRole("button", { name: "A saved image", exact: true });
    await chatTitle.click();
    const image = page.getByRole("img", { name: "Create a tiny image" });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
    await expect(page.getByText("[Image generated]", { exact: false })).toHaveCount(0);
    await expect.poll(() => page.locator(".chat-content").evaluate((content) =>
      content.getBoundingClientRect().width / content.parentElement!.clientWidth)).toBeGreaterThan(0.95);
    await expect.poll(() => page.locator(".chat-thread .entry--assistant").evaluate((entry) => entry.getBoundingClientRect().width)).toBeGreaterThan(1000);

    const menu = page.locator(".chat-row-actions").first();
    await menu.locator("summary").click();
    await expect(menu).toHaveAttribute("open", "");
    await page.locator(".chat-message-bubble").first().click();
    await expect(menu).not.toHaveAttribute("open", "");
    const tools = page.locator(".composer-tools");
    await tools.locator("summary").click();
    const search = tools.getByRole("switch", { name: /Web search/ });
    await expect(search).not.toBeChecked();
    await search.click();
    await expect(search).toBeChecked();
    await page.locator("#chat-draft-input").click();
    await expect(tools).not.toHaveAttribute("open", "");

    await page.getByRole("button", { name: "Chat model and reasoning effort" }).click();
    const picker = page.locator(".desktop-model-dialog");
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId("model-recommendations")).toBeVisible();
    await expect(picker.getByRole("tab", { name: "Image" })).toBeVisible();
    await expect(picker.getByRole("switch", { name: "Smart Adaptive" })).toBeChecked();
    assert.notEqual(await picker.getByTestId("auto-routing-track").evaluate((track) => getComputedStyle(track).backgroundColor), "rgba(0, 0, 0, 0)");
    await page.screenshot({ path: join(artifacts, "model-recommendations.png") });
    await picker.getByRole("button", { name: /^All models/ }).click();
    await expect(picker.getByText("OPENAI", { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: join(artifacts, "model-catalogue.png") });
    await picker.getByTestId("model-filter-sheet-trigger").click();
    await expect(picker.getByTestId("model-filter-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker.getByTestId("model-filter-sheet")).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker.getByTestId("model-recommendations")).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(picker).not.toBeVisible();
    const modelTrigger = page.getByRole("button", { name: "Chat model and reasoning effort" });
    await modelTrigger.click();
    await picker.getByTestId("model-search-input").fill("Gemini");
    await expect(picker.getByTestId("model-option")).toHaveCount(1);
    await picker.getByTestId("model-option").click();
    await expect(picker.getByRole("switch", { name: "Smart Adaptive" })).not.toBeChecked();
    await picker.getByTestId("model-picker-done").click();
    await expect(modelTrigger).toContainText("Gemini Flash-Lite");

    await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.locator(".history--chat #review-history-filters")).toBeAttached();
    await expect(page.locator(".history-header h1")).toHaveText("Review");
    await expect(page.locator(".history-header img")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Review question", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach files", exact: true })).toHaveCount(0);
    await page.locator(".composer-tools summary").click();
    await expect(page.getByRole("button", { name: "Attach files", exact: true })).toBeVisible();
    await expect(page.locator(".desktop-review-starter-grid button")).toHaveCount(3);
    await page.locator(".desktop-review-research").click();
    await expect(page.locator("#review-draft-input")).not.toHaveValue("");
    await page.screenshot({ path: join(artifacts, "review-welcome.png") });
    await page.getByRole("button", { name: /Two saved answers/ }).click();
    const answerList = page.locator(".review-answers").first();
    await expect.poll(() => answerList.evaluate((list) => list.getBoundingClientRect().width)).toBeGreaterThan(1200);
    await expect.poll(() => page.locator(".review-composer-slot").evaluate((slot) => slot.getBoundingClientRect().width)).toBeGreaterThan(1200);
    await page.screenshot({ path: join(artifacts, "review-wide.png") });
    const analysis = page.getByRole("button", { name: "Analyze answers with Tomverse" });
    await expect(analysis).toBeEnabled();
    await analysis.click();
    const dialog = page.getByRole("dialog", { name: "Tomverse answer analysis" });
    await expect(dialog.getByText("The approaches differ").first()).toBeVisible();
    await dialog.getByRole("tab", { name: "Detailed review" }).click();
    await expect(dialog.getByRole("tab", { name: "Detailed review" })).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: join(artifacts, "review-analysis.png") });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "View analysis" }).click();
    await expect(dialog).toBeVisible();
    assert.equal(await app.evaluate(() => (globalThis as typeof globalThis & { runs: number }).runs), 1);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
