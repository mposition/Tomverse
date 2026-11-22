import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { installChatModelStub, mockUserUsage, suppressTransientUi } from "./support/chat-state-fixtures";

const MODEL = "gemini-3-1-pro";
const QUESTION = "Compare the public battery specifications.";
const REPORT = "A saved bounded page research report.";
const REPORT_TIME = "2026-11-15T00:00:00.000Z";

async function setup(page: Page, { unknownCreate = false, unknownResume = false } = {}) {
  await prepareGuestPage(page, "en", "classic", "classic");
  await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: [MODEL], language: "en" });
  await mockUserUsage(page, { plan: "Max", limits: { maxModels: 3, creditsMonth: 10_000 } });
  await page.route("**/api/user/settings**", route => route.fulfill({ json: {
    theme: "dark", language: "en", defaultModel: MODEL, timeZone: "UTC", timeZoneInitializedAt: "2026-05-01T00:00:00Z", timeZoneChangedAt: "2026-05-01T00:00:00Z",
  } }));
  const offers: Record<string, unknown>[] = []; const creates: Record<string, unknown>[] = [];
  let resumes = 0; let cancels = 0; let reads = 0;
  let run: Record<string, unknown> | null = null;
  await page.route("**/api/chat/research-preview/offer", route => {
    offers.push(route.request().postDataJSON());
    return route.fulfill({ json: { offered: true, reason: "ready", estimatedCredits: 24, features: { pageReading: true, durableRuns: true } } });
  });
  await page.route("**/api/chat/research-preview/runs**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/resume")) {
      resumes++;
      run = { ...run, status: "completed", canResume: false, stepCount: 2, searchCount: 1, readCount: 1,
        message: { id: run!.assistantMessageId, role: "assistant", modelId: MODEL, content: REPORT, status: "normal", createdAt: REPORT_TIME,
          searchMetadata: unknownResume ? null : {
            requested: true, supported: true, executed: true, provider: "google", executionKind: "app_managed", searchBackend: "brave",
            queryCount: 1, citations: [], research: {
              version: 2, mode: "preview", evidenceLevel: "search_snippets_and_pages", outcome: "partial",
              startedAt: REPORT_TIME, completedAt: REPORT_TIME, stopReason: "report_submitted",
            },
          },
        } };
      if (unknownResume) return route.abort();
    } else if (path.endsWith("/cancel")) { cancels++; run = { ...run, status: "cancelled", canResume: false }; }
    else if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); creates.push(body);
      run = { id: "preview_run", conversationId: body.conversationId, assistantMessageId: body.assistantMessageId, modelId: MODEL,
        status: "checkpointed", stepCount: 1, searchCount: 1, readCount: 1, canResume: true,
        createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" };
      if (unknownCreate) return route.abort();
    } else if (!path.endsWith("/runs")) reads++;
    return route.fulfill({ json: path.endsWith("/runs") && route.request().method() === "GET" ? { runs: run ? [run] : [] } : { run } });
  });
  await page.route("**/api/chat/context", route => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
  await installChatModelStub(page, { [MODEL]: { kind: "success", chunks: ["A normal follow-up answer."] } });
  await suppressTransientUi(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" }]);
  await page.goto("/chat?lang=en");
  return { offers, creates, resumes: () => resumes, cancels: () => cancels, reads: () => reads };
}

test.describe("Research Preview saved runs", () => {
  test.beforeEach(async ({}, info) => { test.skip(info.project.name !== "desktop-chromium", "One browser drives explicit viewports."); });

  test("a fresh manual Chat starts once, reload only reads, and Resume is explicit", async ({ page }) => {
    const state = await setup(page);
    await page.getByTestId("chat-textarea").fill(QUESTION);
    await page.getByTestId("composer-tools-button").click(); await page.getByTestId("tools-research-preview-row").click();
    expect(state.offers.at(-1)).toEqual({ selectionMode: "manual", modelId: MODEL, question: QUESTION });
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "checkpointed");
    await expect(page.getByTestId("research-run-counts")).toContainText("Pages: 1");
    expect(state.creates).toHaveLength(1); expect(state.resumes()).toBe(0);
    expect(state.creates[0]).not.toHaveProperty("question"); expect(state.creates[0]).not.toHaveProperty("messages");
    await page.reload();
    await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "checkpointed");
    expect(state.creates).toHaveLength(1); expect(state.resumes()).toBe(0);
    await page.getByTestId("research-run-resume").click();
    await expect(page.getByText(REPORT, { exact: true })).toBeVisible(); expect(state.resumes()).toBe(1);
    const card = page.getByTestId("research-run-card");
    await expect(card).toHaveAttribute("data-run-status", "completed");
    await expect(card.getByRole("status")).toHaveText("Research Preview · Report ready");
    await expect(page.getByTestId("research-preview-result")).toHaveAttribute("data-outcome", "partial");
    await expect(page.getByTestId("research-preview-result")).toContainText("Limited report");
    await page.reload();
    await expect(page.getByText(REPORT, { exact: true })).toBeVisible();
    await page.getByTestId("chat-textarea").fill("Explain the saved report."); await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("A normal follow-up answer.", { exact: true })).toBeVisible();
    const requests = await page.evaluate(() => (window as unknown as { __chatModelStubRequests: Record<string, unknown>[] }).__chatModelStubRequests);
    expect(requests).toHaveLength(1); expect(requests[0]).not.toHaveProperty("researchMode");
    expect(requests[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: REPORT })]));
    expect(state.creates).toHaveLength(1); expect(state.resumes()).toBe(1);
  });

  test("Cancel stops future steps and reload does not resume or create another run", async ({ page }) => {
    const state = await setup(page);
    await page.getByTestId("chat-textarea").fill(QUESTION);
    await page.getByTestId("composer-tools-button").click(); await page.getByTestId("tools-research-preview-row").click();
    await page.getByTestId("chat-send-button").click();
    await page.getByTestId("research-run-cancel").click();
    await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "cancelled");
    await page.reload();
    await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "cancelled");
    await expect(page.getByTestId("research-run-resume")).toHaveCount(0);
    expect(state.cancels()).toBe(1); expect(state.creates).toHaveLength(1); expect(state.resumes()).toBe(0);
  });

  test("an unknown create outcome is confirmed by reload without an automatic paid retry", async ({ page }) => {
    const state = await setup(page, { unknownCreate: true });
    await page.getByTestId("chat-textarea").fill(QUESTION);
    await page.getByTestId("composer-tools-button").click(); await page.getByTestId("tools-research-preview-row").click();
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("The outcome could not be confirmed.", { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "checkpointed");
    expect(state.creates).toHaveLength(1); expect(state.resumes()).toBe(0); expect(state.cancels()).toBe(0);
  });

  test("a lost Resume response is confirmed by GET without repeating the action", async ({ page }) => {
    const state = await setup(page, { unknownResume: true });
    await page.getByTestId("chat-textarea").fill(QUESTION);
    await page.getByTestId("composer-tools-button").click();
    await page.getByTestId("tools-research-preview-row").click();
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "checkpointed");
    const readsBeforeResume = state.reads();
    await page.getByTestId("research-run-resume").click();
    await expect(page.getByTestId("research-run-card")).toHaveAttribute("data-run-status", "completed");
    await expect(page.getByText(REPORT, { exact: true })).toBeVisible();
    await expect(page.getByTestId("research-run-card").getByRole("status")).toHaveText("Research Preview · Report ready");
    await expect(page.getByTestId("research-preview-result")).toHaveCount(0);
    expect(state.reads()).toBe(readsBeforeResume + 1);
    expect(state.creates).toHaveLength(1);
    expect(state.resumes()).toBe(1);
    expect(state.cancels()).toBe(0);
  });
});
