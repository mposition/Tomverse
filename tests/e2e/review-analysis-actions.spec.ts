import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage, expectNoHorizontalOverflow } from "./support/app-fixtures";
import { mockComparisonReview, mockConversationHistory, reviewModels } from "./support/comparison-review-fixtures";

test.setTimeout(90000);

async function setup(page: Page, baseURL: string, appearance: "studio" | "classic" = "studio") {
  await prepareGuestPage(page, "ko", appearance, "studio");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels, productKey: "review" });
  await mockConversationHistory(page);
  const api = await mockComparisonReview(page, { withSecondary: true, recoverStored: true, withoutSynthesis: true });
  await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL }]);
  await page.goto("/review?lang=ko&conversation=qa-conversation");
  await expect(page.locator('[data-testid="chat-input"]:visible')).toBeVisible();
  const studio = page.getByTestId("studio-analysis-entry");
  await expect(studio.or(page.getByRole("button", { name: "AI 답변 교차검토" }))).toBeVisible();
  if (await studio.isVisible()) await studio.getByRole("button").click();
  else {
    await page.getByRole("button", { name: "AI 답변 교차검토" }).click();
    await page.getByRole("button", { name: /교차검토 실행/ }).click();
  }
  return api;
}

test("first review is readable before the final event and all transfer actions await completion", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (args[1]?.method !== "POST" || !String(args[0]).includes("/comparison-reviews")) return response;
      const complete = await response.json();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: "primary", data: { ...complete, id: "", persisted: false, result: { ...complete.result, secondary: null } } }) + "\n"));
        Object.assign(window, { finishAnalysis: () => { controller.enqueue(encoder.encode(JSON.stringify({ type: "complete", data: complete }) + "\n")); controller.close(); } });
      } });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
    };
  });
  const api = await setup(page, baseURL!);
  await expect(page.getByTestId("studio-analysis-entry")).toHaveAttribute("data-state", "partial");
  await expect(page.getByRole("heading", { name: "우선순위", exact: true })).toBeVisible();
  await expect(page.getByTestId("review-analysis-share")).toBeDisabled();
  await expect(page.getByTestId("review-analysis-export")).toBeDisabled();
  await expect(page.getByTestId("review-chat-continue")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByTestId("studio-analysis-entry").getByRole("button").click();
  expect(api.getRunCount()).toBe(1);
  await page.evaluate(() => (window as unknown as { finishAnalysis(): void }).finishAnalysis());
  await expect(page.getByTestId("review-analysis-export")).toBeEnabled();
  await expect(page.getByTestId("review-chat-continue")).toBeEnabled();
  await expect(page.getByTestId("studio-analysis-entry")).toHaveAttribute("data-state", "done");
  expect(api.getRunCount()).toBe(1);
});

test("footer keeps Chat immediately left of Close and exports complete verified files in all four formats", async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  const footer = page.getByTestId("review-analysis-actions");
  await expect(page.getByTestId("review-analysis-export")).toBeEnabled();
  const chat = footer.getByTestId("review-chat-continue");
  expect(await chat.evaluate(element => element.parentElement?.nextElementSibling?.textContent)).toBe("닫기");
  const requests: string[] = [];
  await page.route("**/analysis/export", async route => {
    const body = route.request().postDataJSON(); requests.push(body.format);
    expect(body.analysis.reviewer).toBe("primary");
    expect(body.analysis.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(route.request().url()).not.toContain("Compare");
    const bytes = Buffer.from(`Complete analysis ${body.format}`);
    const digest = await page.evaluate(async values => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(values)))).map(value => value.toString(16).padStart(2, "0")).join(""), [...bytes]);
    await route.fulfill({ body: bytes, headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="answer-analysis.${body.format}"`, "X-Export-Bytes": String(bytes.length), "X-Export-SHA256": digest } });
  });
  for (const format of ["pdf", "docx", "txt", "md"]) {
    await footer.getByTestId("review-analysis-export").click();
    const dialog = page.getByRole("dialog", { name: "내보내기", exact: true });
    await expect(page.getByTestId("review-report-preview")).toContainText("Compare these approaches");
    await expect(page.getByTestId("review-report-preview")).toContainText("인용 일치는 사실 정확도를 뜻하지 않습니다");
    await dialog.getByRole("combobox").selectOption(format);
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "내보내기", exact: true }).click();
    expect((await download).suggestedFilename()).toBe(`answer-analysis.${format}`);
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  }
  expect(requests).toEqual(["pdf", "docx", "txt", "md"]);
  await page.setViewportSize({ width: 320, height: 800 });
  // Studio deliberately hands narrow viewports to the Classic surface.
  if (await footer.isVisible()) {
    await expectNoHorizontalOverflow(page);
    for (const button of await footer.getByRole("button").all()) {
      const bounds = await button.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
    }
  }
});

test("sharing previews the selected reviewer, publishes once on confirmation and supports revocation", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic");
  await expect(page.getByTestId("review-analysis-share")).toBeEnabled();
  await page.getByRole("tab", { name: /검토자 2|Reviewer 2/ }).click();
  let published = 0, revoked = 0;
  await page.route("**/qa-conversation/share", async route => {
    if (route.request().method() === "DELETE") { revoked++; return route.fulfill({ json: { success: true } }); }
    published++; expect(route.request().postDataJSON().analysis.reviewer).toBe("secondary");
    await route.fulfill({ json: { url: `${baseURL}/share/fixture-analysis`, expiresAt: "2026-12-01T00:00:00Z" } });
  });
  await page.getByTestId("review-analysis-share").click();
  const dialog = page.getByRole("dialog", { name: "분석 공유", exact: true });
  await expect(page.getByTestId("review-report-preview")).toContainText("claude-sonnet-5");
  await expect(page.getByTestId("review-report-preview")).not.toContainText("우선순위");
  expect(published).toBe(0);
  await dialog.getByRole("button", { name: "공유 링크 만들기", exact: true }).dblclick();
  await expect(dialog.getByRole("textbox")).toHaveValue(`${baseURL}/share/fixture-analysis`);
  expect(published).toBe(1);
  await dialog.getByRole("button", { name: "공유 해제", exact: true }).click();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  expect(revoked).toBe(1);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByTestId("review-analysis-share")).toBeFocused();
});

test("an unknown publication outcome blocks retry until revocation and incomplete bytes never download", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic");
  await expect(page.getByTestId("review-analysis-share")).toBeEnabled();
  let published = 0;
  await page.route("**/qa-conversation/share", route => {
    if (route.request().method() === "DELETE") return route.fulfill({ json: { success: true } });
    published++; return route.fulfill({ status: 503, json: { code: "UNKNOWN" } });
  });
  await page.getByTestId("review-analysis-share").click();
  const dialog = page.getByRole("dialog", { name: "분석 공유", exact: true });
  await dialog.getByRole("button", { name: "공유 링크 만들기", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "공유 링크 만들기", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByTestId("review-analysis-share").click();
  await expect(dialog.getByRole("button", { name: "공유 링크 만들기", exact: true })).toBeDisabled();
  expect(published).toBe(1);
  await dialog.getByRole("button", { name: "공유 해제", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "공유 링크 만들기", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  let downloads = 0; page.on("download", () => downloads++);
  await page.route("**/analysis/export", route => route.fulfill({ body: "truncated", headers: { "X-Export-Bytes": "999", "X-Export-SHA256": "0".repeat(64) } }));
  await page.getByTestId("review-analysis-export").click();
  const exporting = page.getByRole("dialog", { name: "내보내기", exact: true });
  await exporting.getByRole("button", { name: "내보내기", exact: true }).click();
  await expect(exporting.getByRole("status")).toBeVisible();
  expect(downloads).toBe(0);
});

test("identity change fences a late export callback even after the original account returns", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic");
  await expect(page.getByTestId("review-analysis-export")).toBeEnabled();
  let user = "qa-user";
  await page.route("**/api/auth/session**", route => route.fulfill({ json: { user: { id: user, name: user, email: `${user}@tomverse.app`, plan: "Free" }, expires: "2099-01-01T00:00:00Z" } }));
  let release = () => {}; let started = false, downloads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on("download", () => downloads++);
  await page.route("**/analysis/export", async route => {
    started = true; await gate;
    const bytes = Buffer.from("Old account analysis");
    const digest = await page.evaluate(async values => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(values)))).map(value => value.toString(16).padStart(2, "0")).join(""), [...bytes]);
    await route.fulfill({ body: bytes, headers: { "X-Export-Bytes": String(bytes.length), "X-Export-SHA256": digest } }).catch(() => {});
  });
  await page.getByTestId("review-analysis-export").click();
  const dialog = page.getByRole("dialog", { name: "내보내기", exact: true });
  await dialog.getByRole("button", { name: "내보내기", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  user = "qa-user-b"; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(dialog).toHaveCount(0);
  user = "qa-user"; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  release();
  await expect(page.locator('[data-testid="chat-input"]:visible')).toBeVisible();
  expect(downloads).toBe(0);
});

test("Quick Summary uses the same footer and previews its own question, quotes and unresolved matters", async ({ page, baseURL }) => {
  await setup(page, baseURL!, "classic");
  await expect(page.getByTestId("review-analysis-export")).toBeEnabled();
  await page.getByTestId("review-analysis-actions").getByRole("button", { name: "닫기", exact: true }).click();
  const source = { question: "Quick original question", responses: [{ messageId: "a", content: "first quote" }, { messageId: "b", content: "second quote" }] };
  const summary = { id: "quick-1", reviewerModelId: "judge", source, responseMap: [
    { responseId: "A", messageId: "a", modelId: reviewModels[0], modelName: "First model" },
    { responseId: "B", messageId: "b", modelId: reviewModels[1], modelName: "Second model" },
  ], result: { commonConclusions: [{ text: "Quick agreement", citations: [{ responseId: "A", quote: "first quote", verified: false }], verified: false }], importantDifferences: [], modelKeyClaims: [], verificationNeeded: ["Quick unresolved matter"], confidence: "low", groundingStats: { totalCitations: 1, verifiedCitations: 0 } }, usageCredits: 0, cached: true };
  await page.route(/\/compare-summary(?:\?.*)?$/, route => route.fulfill({ json: route.request().method() === "GET" ? { available: true, cached: true, source, storedSummary: summary } : summary }));
  await page.getByTestId("quick-comparison-button").click();
  const footer = page.getByTestId("review-analysis-actions");
  expect(await footer.evaluate(element => element.parentElement?.getAttribute("data-testid"))).toBe("quick-comparison-dialog");
  await footer.getByTestId("review-analysis-export").click();
  await expect(page.getByTestId("review-report-preview")).toContainText("Quick original question");
  await expect(page.getByTestId("review-report-preview")).toContainText("Quick unresolved matter");
  await expect(page.getByTestId("review-report-preview")).toContainText("first quote");
  await page.keyboard.press("Escape");
  await expect(footer.getByTestId("review-analysis-export")).toBeFocused();
});
