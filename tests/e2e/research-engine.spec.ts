import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, openRecentConversation, prepareGuestPage } from "./support/app-fixtures";
import { installChatModelStub, mockUserUsage, suppressTransientUi } from "./support/chat-state-fixtures";

const MODEL = "gemini-3-1-pro";

const view = (patch: Record<string, unknown> = {}) => ({
  id: "engine_run", engineVersion: 2, conversationId: "qa-conversation", assistantMessageId: "11111111-1111-4111-8111-111111111111", status: "running",
  eventSequence: 5, inputRevision: 0, planRevision: 1, approvedPlanRevision: 1, qualityStatus: null, currentReportRevision: 0,
  pauseRequested: false, cancelRequested: false, budgetReached: false,
  plan: { revision: 1, author: "model", plan: { objective: "Compare public sources.", assumptions: ["Public sources only."], clarifications: [],
    subquestions: [{ key: "q1", question: "What changed?", rationale: "r", queries: ["q"], searchLanguages: [], sourceStrategy: "s" }],
    completionCriteria: ["Answered with quotes."], outline: [{ key: "s1", heading: "Changes", purpose: "p", subquestionKeys: ["q1"], table: false }] } },
  progress: { items: { queued: 2, running: 1, completed: 3, failed: 0, attention: 0, blocked: 0, cancelled: 0 },
    questions: [{ key: "q1", question: "What changed?", state: "active", findings: 2 }], sourcesSeen: 12, sourcesRead: 4, privateSources: 0, openQuestions: [] },
  money: { approvedCredits: 400, settledCredits: 60, reservedCredits: 12, unknownCredits: 0, finalizationReserveCredits: 80, settlement: "pending" },
  actions: { canPause: true, canResume: false, canCancel: true, canExtendBudget: true, canApprovePlan: false, canEditPlan: false, canRevise: false,
    canDelete: false, canFinish: true },
  createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z", ...patch,
});

async function setup(page: Page, options: { abortPause?: boolean } = {}) {
  await prepareGuestPage(page, "en", "classic", "classic");
  await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: [MODEL], language: "en" });
  await mockUserUsage(page, { plan: "Max", limits: { maxModels: 3, creditsMonth: 10_000 } });
  let current = view();
  let message: Record<string, unknown> | undefined;
  const posts: string[] = [];
  let reads = 0;
  await page.route("**/api/chat/research/offer**", (route) => route.fulfill({ json: { offered: true, reason: "ready",
    features: { defaultEntry: false, privateSources: false, projectSources: false, maxApprovedCredits: 2_000 },
    estimate: { lowCredits: 120, highCredits: 600, perCallCredits: 12 } } }));
  await page.route("**/api/chat/research-preview/runs**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/runs")) return route.fulfill({ json: { runs: [{ id: current.id, engineVersion: 2, conversationId: current.conversationId,
      assistantMessageId: current.assistantMessageId, modelId: MODEL, status: current.status, stepCount: 0, searchCount: 0, readCount: 0, canResume: false,
      createdAt: current.createdAt, updatedAt: current.updatedAt }] } });
    return route.fulfill({ json: { run: { id: current.id, engineVersion: 2, conversationId: current.conversationId, assistantMessageId: current.assistantMessageId,
      modelId: MODEL, status: current.status, stepCount: 0, searchCount: 0, readCount: 0, canResume: false, createdAt: current.createdAt, updatedAt: current.updatedAt,
      ...(message ? { message } : {}) } } });
  });
  await page.route("**/api/chat/research/runs/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      const action = url.pathname.split("/").at(-1)!;
      posts.push(action);
      if (action === "pause") current = view({ ...current, status: "paused", pauseRequested: true, eventSequence: current.eventSequence + 1,
        actions: { ...current.actions, canPause: false, canResume: true } });
      if (action === "pause" && options.abortPause) return route.abort();
      return route.fulfill({ json: { run: current } });
    }
    reads += 1;
    if (url.pathname.endsWith("/report")) return route.fulfill({ json: { markdown: "# Engine report\n\nThe notice took effect in May [W1].",
      revision: current.currentReportRevision, revisions: [{ revision: current.currentReportRevision, author: "model" }], containsPrivate: false, claims: [] } });
    if (url.pathname.endsWith("/sources")) return route.fulfill({ json: { sources: [
      { id: "s1", sourceKey: "W1", origin: "web_search", visibility: "public", status: "active", title: "Official notice", url: "https://example.gov/notice", versions: [{ readStatus: "read" }] },
      { id: "s2", sourceKey: "W2", origin: "web_search", visibility: "public", status: "active", title: "Wire copy", url: "https://example.com/copy", duplicateOf: "W1", versions: [{ readStatus: "snippet_only" }] },
    ], nextCursor: null } });
    return route.fulfill({ json: { run: current } });
  });
  await installChatModelStub(page, { [MODEL]: { kind: "success", chunks: ["ok"] } });
  await suppressTransientUi(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" }]);
  return { posts, reads: () => reads, setCurrent: (next: ReturnType<typeof view>) => { current = next; }, current: () => current,
    setMessage: (next: Record<string, unknown>) => { message = next; } };
}

test.describe("Deep Research engine v2 workspace", () => {
  test.beforeEach(async ({}, info) => { test.skip(info.project.name !== "desktop-chromium", "One browser drives explicit viewports."); });

  test("a v2 run renders the workspace with counted progress, money and settlement separately, and sources", async ({ page }) => {
    await setup(page);
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);
    const workspace = page.getByTestId("research-workspace");
    await expect(workspace).toHaveAttribute("data-run-status", "running");
    await expect(workspace.getByTestId("research-progress-items")).toHaveText("3 of 6 research steps finished");
    await expect(workspace.getByTestId("research-workspace-money")).toContainText("Some costs are still being settled.");
    await expect(workspace).not.toContainText("%");
    await workspace.getByTestId("research-tab-sources").click();
    await expect(workspace.getByTestId("research-sources")).toContainText("Republishes another source (W1)");
    await expect(workspace.getByTestId("research-sources")).toContainText("Search snippet only");
  });

  test("a lost Pause response is read back, never re-sent, and reload restores the paused run", async ({ page }) => {
    const harness = await setup(page, { abortPause: true });
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);
    const workspace = page.getByTestId("research-workspace");
    await workspace.getByTestId("research-pause").click();
    await expect(workspace).toHaveAttribute("data-run-status", "paused");
    expect(harness.posts.filter((action) => action === "pause")).toHaveLength(1);
    await page.reload();
    await openRecentConversation(page);
    await expect(page.getByTestId("research-workspace")).toHaveAttribute("data-run-status", "paused");
    await expect(page.getByTestId("research-resume")).toBeVisible();
  });

  test("an older poll never overwrites a newer state from another device", async ({ page }) => {
    const harness = await setup(page);
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);
    const workspace = page.getByTestId("research-workspace");
    await expect(workspace).toHaveAttribute("data-event-sequence", "5");
    harness.setCurrent(view({ status: "finalizing", eventSequence: 9 }));
    await expect(workspace).toHaveAttribute("data-run-status", "finalizing", { timeout: 10_000 });
    harness.setCurrent(view({ status: "running", eventSequence: 7 }));
    await page.waitForTimeout(5_000);
    await expect(workspace).toHaveAttribute("data-run-status", "finalizing");
    await expect(workspace).toHaveAttribute("data-event-sequence", "9");
  });

  test("a run that completes while watched shows its report in the chat answer and the report tab without a reload", async ({ page }) => {
    const harness = await setup(page);
    await page.goto("/chat?lang=en");
    await openRecentConversation(page);
    const workspace = page.getByTestId("research-workspace");
    await expect(workspace).toHaveAttribute("data-run-status", "running");
    harness.setMessage({ id: harness.current().assistantMessageId, role: "assistant", content: "## Final engine answer\n\nThe notice took effect in May.",
      status: "normal", modelId: MODEL, pendingJobId: null, researchRunId: "engine_run", searchMetadata: null, createdAt: "2026-11-23T00:00:00Z" });
    harness.setCurrent(view({ status: "completed", eventSequence: 12, currentReportRevision: 1,
      actions: { ...harness.current().actions, canPause: false, canCancel: false, canFinish: false } }));
    await expect(workspace).toHaveAttribute("data-run-status", "completed", { timeout: 10_000 });
    await expect(page.getByText("Final engine answer")).toBeVisible();
    await workspace.getByTestId("research-tab-report").click();
    await expect(workspace.getByTestId("research-report-body")).toContainText("The notice took effect in May");
    await expect(workspace.getByTestId("research-report-body").getByRole("heading", { name: "Engine report" })).toBeVisible();
  });
});
