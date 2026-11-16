import { buildChatStreamTrailerChunk } from "../../lib/webSearchStreamTrailer";
import { observeConnectedJourneyEvents } from "./support/connected-journey-fixtures";
import { expect, test, type Page } from "@playwright/test";
import { mockReviewHandoffBackground } from "./support/review-handoff-background-fixtures";
import { mockAuthenticatedApi, prepareGuestPage, expectNoHorizontalOverflow } from "./support/app-fixtures";
import { mockComparisonReview, mockConversationHistory, reviewModels } from "./support/comparison-review-fixtures";

test.setTimeout(90000);

async function setup(page: Page, baseURL: string, appearance: "studio" | "classic" = "studio") {
  await mockReviewHandoffBackground(page);
  await prepareGuestPage(page, "ko", appearance, "studio");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels, productKey: "review", extraConversations: [
    { id: "previous-chat", title: "Previous Chat", productKey: "chat", selectedModels: [reviewModels[0]] },
  ] });
  const journeys = await observeConnectedJourneyEvents(page, baseURL);
  let analysisSetup: Record<string, unknown> = {};
  page.on("response", async response => {
    if (response.request().method() === "GET" && /\/comparison-reviews(?:\?|$)/.test(response.url())) analysisSetup = await response.json().catch(() => ({}));
  });
  await mockConversationHistory(page);
  const api = await mockComparisonReview(page, { withSecondary: true, recoverStored: true, withoutSynthesis: true });
  await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL }]);
  await page.goto("/review?lang=ko&conversation=qa-conversation");
  await expect(page.locator('[data-testid="chat-input"]:visible')).toBeVisible();
  await expect(page.getByTestId("studio-analysis-entry")
    .or(page.getByRole("button", { name: "AI 답변 교차검토" }))).toBeVisible();
  return { ...api, journeys, getSetup: () => analysisSetup };
}
async function openAnalysis(page: Page) {
  const studio = page.getByTestId("studio-analysis-entry");
  await expect(studio.or(page.getByRole("button", { name: "AI 답변 교차검토" }))).toBeVisible();
  if (await studio.isVisible()) await studio.getByRole("button").click();
  else {
    await page.getByRole("button", { name: "AI 답변 교차검토" }).click();
    await page.getByRole("button", { name: /교차검토 실행/ }).click();
  }
  await expect(page.getByTestId("review-chat-continue")).toBeEnabled();
}
const draftInput = (page: Page) => page.locator('[data-testid="chat-input"]:visible textarea');

test("saved balanced result crosses client navigation once, waits for new draft hydration and sends nothing", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  const api = await setup(page, baseURL!);
  await openAnalysis(page);
  let release = () => {};
  let firstHydration = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/products/chat/drafts/new", async route => {
    if (route.request().method() !== "GET" || !firstHydration) return route.fallback();
    firstHydration = false;
    await gate; await route.fulfill({ json: { draft: null } });
  });
  const forbidden: string[] = [];
  page.on("request", req => {
    if (req.method() !== "GET" && /\/api\/(?:chat$|products\/chat\/conversations$|conversations\/[^/]+\/messages$)/.test(new URL(req.url()).pathname)) forbidden.push(req.url());
  });
  await page.getByTestId("review-chat-continue").click();
  await expect(page.getByTestId("review-chat-preview")).toContainText("Compare these approaches");
  await expect(page.getByTestId("review-chat-preview")).toContainText("인용 일치는 사실 정확도를 뜻하지 않습니다");
  await page.getByTestId("review-chat-request").fill("검증할 작업 목록을 만들어주세요");
  await page.evaluate(() => sessionStorage.setItem("tomverse_active_chat_id", "previous-chat"));
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).dblclick();
  await expect(page).toHaveURL(/\/chat\?reviewDraft=/);
  await expect(draftInput(page)).toHaveValue("");
  expect(page.url()).not.toContain("Compare");
  release();
  await expect(draftInput(page)).toHaveValue(/Compare these approaches[\s\S]*검증할 작업 목록/);
  await expect(page).not.toHaveURL(/reviewDraft/);
  expect((await draftInput(page).inputValue()).split("Compare these approaches")).toHaveLength(2);
  expect(api.getRunCount()).toBe(1); expect(forbidden).toEqual([]);
  await expect.poll(() => api.journeys.map(e => e.journey_stage)).toEqual(["started", "preview_ready", "ready"]);
  expect(api.journeys[0].journey_entry).toBe("review_studio");
  const editedSaved = page.waitForResponse(response => response.url().endsWith("/api/products/chat/drafts/new") && response.request().method() === "PUT" && response.request().postDataJSON().text === "User edited draft");
  await draftInput(page).fill("User edited draft");
  await editedSaved;
  await page.goBack(); await expect(page).toHaveURL(/\/review/);
  await page.goForward(); await expect(draftInput(page)).toHaveValue("User edited draft");
  await page.reload();
  await expect(draftInput(page)).toHaveValue("User edited draft");
  await expect(page.getByRole("dialog", { name: "채팅 초안 미리보기" })).toHaveCount(0);
});

test("selecting another Chat discards a pending packet and fences a late new-draft read", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic"); await openAnalysis(page);
  await page.getByTestId("review-chat-continue").click();
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/products/chat/drafts/new", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    await gate; await route.fulfill({ json: { draft: null } }).catch(() => {});
  });
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect(page).toHaveURL(/reviewDraft=/);
  const mobileMenu = page.getByTestId("mobile-sidebar-open");
  const mobile = await mobileMenu.isVisible();
  if (mobile) await mobileMenu.click();
  else await page.locator(".review-navigation-history").click();
  const history = mobile ? page.getByTestId("mobile-sidebar-drawer") : page.getByRole("dialog", { name: "기록", exact: true });
  await history.getByTestId("sidebar-conversation-item").filter({ hasText: "Previous Chat" }).click();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/reviewDraft/);
  release();
  await expect(draftInput(page)).toHaveValue("");
  await expect(page.getByText("Compare these approaches", { exact: true })).toHaveCount(0);
});

for (const decision of ["append", "cancel"] as const) {
  test(`Classic selected reviewer finding preserves an existing draft on ${decision}`, async ({ page, baseURL }) => {
    const api = await setup(page, baseURL!, "classic");
    await openAnalysis(page);
    const reviewer = page.getByRole("tab", { name: /검토자 2|Reviewer 2/ });
    if (await reviewer.isVisible()) await reviewer.click();
    await page.locator('[data-testid="review-chat-issue"]:visible').first().click();
    await expect(page.getByTestId("review-chat-preview")).toContainText("미확인 사항과 한계");
    const uploadId = "61111111-1111-4111-8111-111111111111";
    await page.route("**/api/products/chat/drafts/new", route => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({ json: { draft: { scopeKey: "new", text: "Existing draft", revision: 3, createdAt: "2026-11-14T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z",
        attachmentReferences: [{ uploadId }], attachments: [{ id: uploadId, uploadId, ordinal: 0, name: "kept.txt", mediaType: "text/plain", size: 4, kind: "text" }] } } });
    });
    await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
    const conflict = page.getByRole("dialog", { name: /이미 채팅 초안/ });
    await expect(conflict).toBeVisible();
    await expect(draftInput(page)).toHaveValue("Existing draft");
    await expect(page.locator('[data-testid="chat-input"]:visible').getByText("kept.txt", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await conflict.getByRole("button", { name: decision === "append" ? "기존 초안에 추가" : "취소", exact: true }).click();
    if (decision === "append") await expect(draftInput(page)).toHaveValue(/^Existing draft\n\n[\s\S]*Compare these approaches/);
    else await expect(draftInput(page)).toHaveValue("Existing draft");
    await expect(page).not.toHaveURL(/reviewDraft/);
    await expect(page.locator('[data-testid="chat-input"]:visible').getByText("kept.txt", { exact: true })).toBeVisible();
    if (decision === "append") await expect(page.getByTestId("draft-conflict-dialog")).toBeVisible();
    await expect.poll(() => api.journeys.map(e => e.journey_stage)).toEqual(["started", "preview_ready", "issue", decision === "append" ? "ready" : "cancelled"]);
    expect(new Set(api.journeys.map(e => e.journey_key)).size).toBe(1);
  });
}

test("authorization failure keeps source and never navigates; missing marker recovers a new draft", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic"); await openAnalysis(page);
  await page.getByTestId("review-chat-continue").click();
  await page.route(/\/comparison-reviews\?/, route => route.fulfill({ status: 403, json: { code: "CONVERSATION_LOCKED" } }));
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "채팅 초안 미리보기" }).getByRole("alert")).toContainText("접근 권한");
  await expect(page).toHaveURL(/\/review/);
  await page.goto("/chat?reviewDraft=missing");
  await expect(page).not.toHaveURL(/reviewDraft/);
  await expect(draftInput(page)).toHaveValue("");
});

test("a regenerated result refuses the captured preview without starting another analysis", async ({ page, baseURL }) => {
  const api = await setup(page, baseURL!, "classic"); await openAnalysis(page);
  await page.getByTestId("review-chat-continue").click();
  const saved = structuredClone(api.getStoredReview()) as Record<string, unknown>;
  saved.result = { changed: true };
  await page.route(/\/comparison-reviews\?/, route => route.fulfill({ json: { available: true,
    source: { question: "A regenerated question", responses: [] }, storedReview: saved } }));
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "채팅 초안 미리보기" }).getByRole("alert")).toContainText("결과가 바뀌었거나");
  expect(api.getRunCount()).toBe(1); await expect(page).toHaveURL(/\/review/);
});

test("identity change cancels pending access confirmation, including a late callback after A returns", async ({ page, baseURL }) => {
  const api = await setup(page, baseURL!, "classic"); await openAnalysis(page);
  let user = "qa-user";
  await page.route("**/api/auth/session**", route => route.fulfill({ json: { user: { id: user, name: user, email: `${user}@tomverse.app`, plan: "Free" }, expires: "2099-01-01T00:00:00Z" } }));
  await page.getByTestId("review-chat-continue").click();
  let release = () => {}; let started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/comparison-reviews\?/, async route => { started = true; await gate; await route.fulfill({ json: { ...api.getSetup(), storedReview: api.getStoredReview() } }).catch(() => {}); });
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  user = "qa-user-b"; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("review-chat-preview")).toHaveCount(0);
  user = "qa-user"; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  release();
  await expect(page).toHaveURL(/\/review/);
  await expect(page.getByTestId("review-chat-preview")).toHaveCount(0);
});

test("an unapplied packet expires and removes its marker without overwriting the server draft", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic"); await openAnalysis(page);
  await page.getByTestId("review-chat-continue").click();
  await page.route("**/api/products/chat/drafts/new", route => route.fulfill({ status: 500, json: {} }));
  await page.clock.install();
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect(page).toHaveURL(/reviewDraft=/);
  await page.clock.fastForward(5 * 60_000 + 1000);
  await expect(page).not.toHaveURL(/reviewDraft/);
  await expect(draftInput(page)).toHaveValue("");
});

test("identity change while hydrating never applies A's packet after B or after A returns", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic"); await openAnalysis(page);
  let user = "qa-user";
  await page.route("**/api/auth/session**", route => route.fulfill({ json: { user: { id: user, name: user, email: `${user}@tomverse.app`, plan: "Free" }, expires: "2099-01-01T00:00:00Z" } }));
  await page.getByTestId("review-chat-continue").click();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/products/chat/drafts/new", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    await gate; await route.fulfill({ json: { draft: null } }).catch(() => {});
  });
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect(page).toHaveURL(/reviewDraft=/);
  user = "qa-user-b"; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page).not.toHaveURL(/reviewDraft/);
  await expect(draftInput(page)).toHaveValue("");
  user = "qa-user"; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  release();
  await expect(draftInput(page)).toHaveValue("");
  await expect(page.getByTestId("review-chat-preview")).toHaveCount(0);
});

test("preview fits 320px at enlarged text and Escape returns focus to the source action", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await page.setViewportSize({ width: 320, height: 844 });
  await setup(page, baseURL!, "classic"); await openAnalysis(page);
  await page.getByTestId("review-chat-continue").click();
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  const dialog = page.getByRole("dialog", { name: "채팅 초안 미리보기" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByTestId("review-chat-request")).toBeFocused();
  await page.screenshot({ path: ".tmp-review-chat-mobile-preview.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("review-chat-preview")).toHaveCount(0);
  await expect(page.getByTestId("review-chat-continue")).toBeFocused();
});

test("Quick Summary projects its own saved shape and actual Send uses the ordinary Chat path", async ({ page, baseURL }) => {
  const api = await setup(page, baseURL!, "classic");
  const source = { question: "Quick original question", responses: [{ messageId: "a", content: "first quote" }, { messageId: "b", content: "second quote" }] };
  const summary = { id: "quick-1", title: "Quick", reviewerModelId: "judge", source, responseMap: [
    { responseId: "A", messageId: "a", modelId: reviewModels[0], modelName: "First model" },
    { responseId: "B", messageId: "b", modelId: reviewModels[1], modelName: "Second model" },
  ], result: { commonConclusions: [{ text: "Quick agreement", citations: [{ responseId: "A", quote: "first quote", verified: false }], verified: false }], importantDifferences: [], modelKeyClaims: [], verificationNeeded: ["Check this later"], confidence: "low", groundingStats: { totalCitations: 1, verifiedCitations: 0 } }, usageCredits: 0, cached: true };
  let quickRuns = 0;
  await page.route(/\/compare-summary(?:\?.*)?$/, route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { available: true, cached: true, source, storedSummary: summary } });
    quickRuns++; return route.fulfill({ json: summary });
  });
  await page.getByTestId("quick-comparison-button").click();
  await page.getByTestId("review-chat-continue").click();
  await expect(page.getByTestId("review-chat-preview")).toContainText("Quick agreement");
  await expect(page.getByTestId("review-chat-preview")).toContainText("Check this later");
  await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: [reviewModels[0]] });
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect(draftInput(page)).toHaveValue(/Quick original question/);
  expect(quickRuns).toBe(1);
  await page.route("**/api/chat", route => route.fulfill({ contentType: "text/plain; charset=utf-8", headers: { "X-Request-ID": "handoff-send-fixture" }, body: "Follow-up from the existing Chat path" }));
  const writes: string[] = [];
  page.on("request", req => { if (req.method() === "POST") writes.push(new URL(req.url()).pathname); });
  await page.getByTestId("chat-send-button").click();
  await expect.poll(() => writes.filter(url => url === "/api/products/chat/conversations").length).toBe(1);
  await expect.poll(() => writes.some(url => url === "/api/conversations/qa-conversation/messages")).toBe(true);
  await expect.poll(() => writes.filter(url => url === "/api/chat").length).toBe(1);
  await expect(page.getByText("Follow-up from the existing Chat path", { exact: true })).toBeVisible();
  await expect.poll(() => api.journeys.map(e => e.journey_stage)).toEqual(["started", "preview_ready", "ready", "send_dispatched", "reply_observed"]);
  expect(new Set(api.journeys.map(e => e.journey_key)).size).toBe(1);
  expect(api.journeys[0].journey_entry).toBe("review_quick_summary");
});

test("failed hydration preserves the packet; cancel fences a late GET and manual typing", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic"); await openAnalysis(page);
  await page.getByTestId("review-chat-continue").click();
  let fail = true; let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route("**/api/products/chat/drafts/new", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    if (fail) return route.fulfill({ status: 500, json: {} });
    await gate; return route.fulfill({ json: { draft: null } });
  });
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(draftInput(page)).toHaveValue("");
  fail = false;
  await expect.poll(() => reads, { timeout: 10000 }).toBeGreaterThan(1);
  await page.getByRole("status").filter({ hasText: "새 채팅 초안" }).getByRole("button", { name: "취소" }).click();
  await draftInput(page).fill("Typed while hydration was pending");
  release();
  await expect(draftInput(page)).toHaveValue("Typed while hydration was pending");
  await expect(page).not.toHaveURL(/reviewDraft/);
});

for (const appearance of ["studio", "classic"] as const) {
  test(`connected ${appearance} handoff observes the first ordinary response`, async ({ page, baseURL }) => {
    const api = await setup(page, baseURL!, appearance);
    await openAnalysis(page);
    await page.getByTestId("review-chat-continue").click();
    await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: [reviewModels[0]] });
    await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
    await expect(draftInput(page)).toHaveValue(/Compare these approaches/);
    await page.route("**/api/chat", route => route.fulfill({ contentType: "text/plain; charset=utf-8", body: "Observed first connected answer" }));
    await page.getByTestId("chat-send-button").click();
    await expect.poll(() => api.journeys.map(e => e.journey_stage)).toEqual(["started", "preview_ready", "ready", "send_dispatched", "reply_observed"]);
    expect(new Set(api.journeys.map(e => e.journey_key)).size).toBe(1);
    expect(api.journeys[0].journey_entry).toBe(`review_${appearance}`);
  });
}

for (const completion of ["incomplete", "empty"] as const) {
  test(`connected first stream excludes ${completion} answers`, async ({ page, baseURL }) => {
    const api = await setup(page, baseURL!, "classic");
    await openAnalysis(page);
    await page.getByTestId("review-chat-continue").click();
    await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: [reviewModels[0]] });
    await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
    await expect(draftInput(page)).toHaveValue(/Compare these approaches/);
    await page.route("**/api/chat", route => route.fulfill({ contentType: "text/plain; charset=utf-8", body: completion === "empty" ? " " : "Truncated answer" + buildChatStreamTrailerChunk({ searchMetadata: null, completion: { status: "incomplete", incompleteReason: "length" } }) }));
    await page.getByTestId("chat-send-button").click();
    await expect.poll(() => api.journeys.map(e => e.journey_stage)).toEqual(["started", "preview_ready", "ready", "send_dispatched", "issue"]);
    expect(api.journeys.at(-1)?.journey_reason).toBe(completion === "empty" ? "empty_response" : "response_incomplete");
  });
}

test("connected draft clear prevents a later ordinary question from inheriting the journey", async ({ page, baseURL }) => {
  const api = await setup(page, baseURL!, "classic");
  await openAnalysis(page);
  await page.getByTestId("review-chat-continue").click();
  await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: [reviewModels[0]] });
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect(draftInput(page)).toHaveValue(/Compare these approaches/);
  await draftInput(page).fill("");
  await expect.poll(() => api.journeys.at(-1)?.journey_reason).toBe("draft_cleared");
  await draftInput(page).fill("An unrelated new question");
  await page.route("**/api/chat", route => route.fulfill({ contentType: "text/plain; charset=utf-8", body: "Unrelated answer" }));
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByText("Unrelated answer", { exact: true })).toBeVisible();
  expect(api.journeys.map(e => e.journey_stage)).toEqual(["started", "preview_ready", "ready", "invalidated"]);
});

test("connected dispatched marker observes an exact completed source on reload without resending", async ({ page, baseURL }) => {
  const api = await setup(page, baseURL!, "classic");
  await openAnalysis(page);
  await page.getByTestId("review-chat-continue").click();
  await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: [reviewModels[0]] });
  await page.getByRole("button", { name: "채팅 초안 열기", exact: true }).click();
  await expect(draftInput(page)).toHaveValue(/Compare these approaches/);
  let sent: Record<string, string> = {};
  let posts = 0;
  await page.route("**/api/chat", route => { sent = route.request().postDataJSON(); posts++; return route.abort("failed"); });
  await page.getByTestId("chat-send-button").click();
  await expect.poll(() => api.journeys.some(e => e.journey_stage === "issue")).toBe(true);
  expect(api.journeys.some(e => e.journey_stage === "reply_observed")).toBe(false);
  const count = posts;
  const timestamp = new Date().toISOString();
  const attempt = { assistantMessageId: sent.assistantMessageId, conversationId: "qa-conversation", sourceUserMessageId: sent.sourceUserMessageId, requestedModelId: reviewModels[0], actualModelId: reviewModels[0], provider: "openai", status: "completed", partialContent: "Canonical recovered answer", checkpointRevision: 1, finishReason: "stop", failureCode: null, terminalAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
  await page.route(url => url.pathname === "/api/conversations/qa-conversation", route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { id: "qa-conversation", title: "Recovered conversation", kind: "chat", productKey: "chat", surface: "chat", selectedModels: [reviewModels[0]], disabledPanels: [], selectionMode: "manual", webSearchMode: "off", memoryMode: "inherit", isLocked: false, messages: [
      { id: sent.sourceUserMessageId, role: "user", content: "Connected question", createdAt: timestamp },
      { id: sent.assistantMessageId, role: "assistant", content: "Canonical recovered answer", status: "normal", modelId: reviewModels[0], createdAt: timestamp },
    ], responseAttempts: [attempt], messagePage: { hasMore: false, nextCursor: null } } });
  });
  await page.reload();
  await expect(page.getByText("Canonical recovered answer", { exact: true })).toBeVisible();
  await expect.poll(() => api.journeys.some(e => e.journey_stage === "reply_observed")).toBe(true);
  expect(posts).toBe(count);
  expect(new Set(api.journeys.map(e => e.journey_key)).size).toBe(1);
});
