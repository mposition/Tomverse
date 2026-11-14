import { expect, test, type Page } from "@playwright/test";
import { mockAttachmentUpload, mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { installChatModelStub, mockUserUsage, restoreActiveConversation, suppressTransientUi } from "./support/chat-state-fixtures";

const MODEL = "gemini-3-1-pro";
const QUESTION = "Compare the public battery specifications of two products.";
const PRIVATE_HISTORY = "Private earlier conversation: never send this to web research.";
const REPORT = "Research report. [1](<https://example.org/specification>)";
const metadata = {
  requested: true, supported: true, executed: true, provider: "google",
  executionKind: "app_managed", searchBackend: "brave", queryCount: 1,
  citations: [{ url: "https://example.org/specification", title: "Public specification", referenceNumber: 1 }],
  research: {
    version: 1, mode: "preview", evidenceLevel: "search_snippets", outcome: "partial",
    startedAt: "2026-11-15T00:00:00.000Z", completedAt: "2026-11-15T00:00:03.000Z",
    stopReason: "report_submitted",
  },
};

async function prepare(page: Page, offered = true, saved = false) {
  await prepareGuestPage(page, "en", "classic", "classic");
  const account = await mockAuthenticatedApi(page, {
    productKey: "chat", selectedModels: [MODEL], language: "en", memoryMode: "on",
    messages: [
      { id: "qa-private-user", role: "user", content: PRIVATE_HISTORY },
      { id: "qa-private-assistant", role: "assistant", content: "Earlier private answer.", modelId: MODEL },
      ...(saved ? [{ id: "qa-research-report", role: "assistant" as const, content: REPORT, modelId: MODEL, searchMetadata: metadata }] : []),
    ],
  });
  await mockUserUsage(page, { plan: "Max", limits: { maxModels: 3, creditsMonth: 10_000 } });
  await page.route("**/api/chat/research-preview/offer", route => route.fulfill({ json: {
    offered, reason: offered ? "ready" : "disabled", ...(offered ? { estimatedCredits: 19 } : {}),
  } }));
  await page.route("**/api/chat/context", route => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
  await installChatModelStub(page, { [MODEL]: { kind: "success", chunks: [REPORT] } });
  await suppressTransientUi(page);
  await restoreActiveConversation(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" }]);
  await page.goto("/chat?lang=en");
  await expect(page.getByText("Earlier private answer.", { exact: true })).toBeVisible();
  return account;
}

test.describe("Research Preview", () => {
  test.beforeEach(async ({}, info) => {
    test.skip(info.project.name !== "desktop-chromium", "Explicit responsive viewports.");
  });

  test("a disabled server offer leaves Perplexity available and the draft unchanged", async ({ page }) => {
    await prepare(page, false);
    const offered = page.waitForResponse("**/api/chat/research-preview/offer");
    await page.getByTestId("chat-textarea").fill(QUESTION);
    expect((await offered).request().postDataJSON()).toEqual({ conversationId: "qa-conversation", modelId: MODEL, question: QUESTION });
    await page.getByTestId("composer-tools-button").click();
    await expect(page.getByTestId("tools-research-preview-row")).toHaveCount(0);
    await expect(page.getByTestId("tools-deep-research-row")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(QUESTION);
  });

  test("sends only the current question once and the follow-up returns to normal Chat", async ({ page }) => {
    const account = await prepare(page);
    const contextRequests: string[] = [];
    const settingsWrites: Record<string, unknown>[] = [];
    page.on("request", request => {
      if (/\/api\/chat\/(context|location-intent|prompt-refiner\/prepare)/.test(request.url())) contextRequests.push(request.url());
      if (request.method() === "PATCH" && /\/api\/conversations\/[^/]+$/.test(request.url())) settingsWrites.push(request.postDataJSON());
    });
    await page.getByTestId("chat-textarea").fill(QUESTION);
    await page.getByTestId("composer-tools-button").click();
    await page.getByTestId("tools-research-preview-row").click();
    await expect(page.getByTestId("research-preview-question")).toHaveText(QUESTION);
    await expect(page.getByTestId("research-preview-estimate")).toContainText("19 credits");
    const before = contextRequests.length;
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("Research report.", { exact: false }).last()).toBeVisible();
    await expect(page.getByTestId("research-preview-notice")).toHaveCount(0);
    const requests = await page.evaluate(() => (window as unknown as { __chatModelStubRequests: Record<string, unknown>[] }).__chatModelStubRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0].researchMode).toBe("preview");
    expect(requests[0].modelId).toBe(MODEL);
    expect(requests[0].messages).toEqual([expect.objectContaining({ role: "user", content: QUESTION })]);
    expect(JSON.stringify(requests[0])).not.toContain(PRIVATE_HISTORY);
    for (const key of ["contextBundle", "mcpConnectionId", "currentLocation", "promptRefinerDecision"]) expect(requests[0]).not.toHaveProperty(key);
    expect(contextRequests.length).toBe(before);
    await page.getByTestId("chat-textarea").fill("Explain the report in simpler terms.");
    await page.getByTestId("chat-send-button").click();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __chatModelStubRequests: unknown[] }).__chatModelStubRequests)).length).toBe(2);
    const followUp = await page.evaluate(() => (window as unknown as { __chatModelStubRequests: Record<string, unknown>[] }).__chatModelStubRequests[1]);
    expect(followUp).not.toHaveProperty("researchMode");
    expect(account.selectedModels).toEqual([MODEL]);
    expect(account.selectionMode).toBe("manual");
    for (const write of settingsWrites) {
      expect(write).not.toHaveProperty("productKey");
      if ("selectedModels" in write) expect(write.selectedModels).toEqual([MODEL]);
    }
  });

  test("keeps an attached draft and offers normal Chat without silently removing files", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepare(page);
    await mockAttachmentUpload(page);
    await page.getByTestId("chat-textarea").fill(QUESTION);
    await page.getByTestId("composer-tools-button").click();
    await page.getByTestId("tools-research-preview-row").click();
    await page.getByTestId("composer-tools-button").click();
    await page.getByTestId("tools-attach-row").click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("attach-local-file-row").click();
    await (await chooser).setFiles({ name: "private-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Private notes.") });
    await expect(page.getByTestId("attachment-complete")).toBeVisible();
    await expect(page.getByTestId("research-preview-blocked")).toContainText("draft and files are preserved");
    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
    await page.getByTestId("research-preview-clear").click();
    await expect(page.getByTestId("attachment-complete")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(QUESTION);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    const textarea = await page.getByTestId("composer-textarea-row").boundingBox();
    expect(textarea?.width).toBeGreaterThan(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("retains explicit Research while checking an edited question and blocks an oversized draft", async ({ page }) => {
    await prepare(page);
    await page.getByTestId("chat-textarea").fill(QUESTION);
    await page.getByTestId("composer-tools-button").click();
    await page.getByTestId("tools-research-preview-row").click();
    let releaseOffer: (() => void) | undefined;
    const held = new Promise<void>(resolve => { releaseOffer = resolve; });
    await page.route("**/api/chat/research-preview/offer", async route => {
      await held;
      await route.fulfill({ json: { offered: true, reason: "ready", estimatedCredits: 20 } });
    });
    await page.getByTestId("chat-textarea").fill(`${QUESTION} Focus on warranties.`);
    await expect(page.getByTestId("research-preview-notice")).toBeVisible();
    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
    releaseOffer?.();
    await expect(page.getByTestId("research-preview-estimate")).toContainText("20 credits");
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-textarea").fill("x".repeat(4001));
    await expect(page.getByTestId("research-preview-blocked")).toContainText("1–4,000");
    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("x".repeat(4001));
    expect(await page.evaluate(() => (window as unknown as { __chatModelStubRequests: unknown[] }).__chatModelStubRequests)).toHaveLength(0);
  });

  test("reload restores a limited report and its citation without starting another run", async ({ page }) => {
    await prepare(page, true, true);
    await expect(page.getByTestId("research-preview-result")).toHaveAttribute("data-outcome", "partial");
    await expect(page.getByTestId("search-citation-item")).toHaveAttribute("data-reference-number", "1");
    await expect(page.getByTestId("search-citation-item").getByRole("link")).toHaveAttribute("href", "https://example.org/specification");
    await page.reload();
    await expect(page.getByTestId("research-preview-result")).toHaveAttribute("data-outcome", "partial");
    expect(await page.evaluate(() => (window as unknown as { __chatModelStubRequests: unknown[] }).__chatModelStubRequests)).toHaveLength(0);
  });
});
