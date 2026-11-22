import { expect, test, type Page } from "@playwright/test";
import { makeReviewReportFixture } from "../fixtures/reviewAnalysisReport";
import { selectProduct } from "./workspaceNavigation";

test.beforeEach(async ({ page }) => {
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.addInitScript(() => localStorage.setItem("tomverse-language", "ko"));
});

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeEnabled();
}

for (const theme of ["light", "dark"]) test(`approved native home and library in ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 412, height: 892 });
  await page.addInitScript(theme => localStorage.setItem("tomverse-theme", theme), theme);
  await signIn(page);
  const home = page.getByTestId("workspace-start");
  await expect(home.locator("h1")).toHaveText("AI를 고르지 않아도,질문부터 시작하세요.");
  await expect(home.getByTestId("ios-starter-image")).toBeInViewport();
  await expect(home.getByRole("button", { name: /다른 AI의 대화 이어가기/ })).toBeInViewport();
  expect(await page.locator(".brand-lockup").evaluate(node => { const rect = node.getBoundingClientRect(); return Math.abs(rect.x + rect.width / 2 - innerWidth / 2); })).toBeLessThan(1);
  await page.screenshot({ path: info.outputPath(`home-${theme}.png`) });
  await page.locator(".ios-navigation").getByRole("button", { name: "보관함", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "내 어시스턴트", exact: true })).toBeVisible();
  await expect(dialog.getByTestId("ios-starter-xlsx")).toBeVisible();
  await page.screenshot({ path: info.outputPath(`library-${theme}.png`) });
  await dialog.getByTestId("ios-starter-xlsx").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue(/Excel/);
  await expect(page.locator("article.user")).toHaveCount(0);
});

async function savedReview(page: Page, changed = false) {
  const fixture = makeReviewReportFixture();
  await page.addInitScript(source => {
    localStorage.setItem("tomverse-native-synthetic-demo", JSON.stringify([{ id: source.conversationId, title: "Saved comparison", surface: "workspace", selectedModels: ["demo", "demo-b"], messages: [
      { id: "prompt-1", role: "user", content: source.setup.source!.question },
      ...source.setup.source!.responses.map((answer, index) => ({ id: answer.messageId, role: "assistant", modelId: index ? "demo-b" : "demo", content: answer.content, status: "normal" })),
    ] }]));
  }, fixture);
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const injection = `const fixture=${JSON.stringify(fixture)};let paid=0;let cached=false;
      transport.reviewPreview=async()=>({...fixture.setup,estimatedCredits:0.2,assistantMessageIds:["answer-a","answer-b"],storedReview:cached?fixture.review:undefined});
      transport.runComparison=async()=>{paid++;localStorage.setItem('analysis-paid-calls',String(paid));cached=true;return fixture.review;};
      transport.quickSummaryPreview=async()=>({available:true,estimatedCredits:0.1,cached,source:fixture.setup.source,storedSummary:cached?{id:'quick-1',reviewerModelId:'reviewer-a',responseMap:fixture.review.responseMap,result:{commonConclusions:fixture.review.result.primary.result.consensus,importantDifferences:[],modelKeyClaims:[],verificationNeeded:['Check dates.']}}:undefined});
      transport.runQuickSummary=async()=>{paid++;localStorage.setItem('analysis-paid-calls',String(paid));cached=true;return {};};
      ${changed ? "const original=transport.quickSummaryPreview;transport.quickSummaryPreview=async()=>{const value=await original();if(cached)value.source={...value.source,question:'Changed question'};return value;};" : ""}
      `;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", `${injection}createRoot(container).render(`) });
  });
  await signIn(page);
  await page.getByRole("textbox").fill("Keep my original draft");
  await selectProduct(page, "review");
  await page.getByRole("button", { name: "대화", exact: true }).click();
  await page.getByRole("button", { name: "Saved comparison", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Local demo A/ })).toBeVisible();
}

test("quick summary requires confirmation and opens an unsent Chat reference without losing its draft", async ({ page }, info) => {
  await savedReview(page);
  await page.getByRole("tab", { name: /Local demo B/ }).click();
  await expect(page.locator("#review-message-answer-b")).toBeVisible();
  await page.screenshot({ path: info.outputPath("review-provider-tabs.png") });
  await page.getByTestId("native-quick-summary").click();
  expect(await page.evaluate(() => localStorage.getItem("analysis-paid-calls"))).toBeNull();
  await expect(page.getByRole("dialog")).toContainText("0.1");
  await page.getByRole("button", { name: "차이 요약 실행", exact: true }).click();
  await page.getByRole("button", { name: "채팅에서 이어가기", exact: true }).click();
  await expect(page.getByTestId("native-review-chat-preview")).not.toContainText("PRIVATE_FULL_ANSWER");
  await page.getByRole("button", { name: "기존 초안에 추가", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue(/^Keep my original draft\n\n비교 참고 자료/);
  await expect(page.locator("article.user")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("analysis-paid-calls"))).toBe("1");
});

test("cross-review uses the saved result and requires a preview before continuing", async ({ page }) => {
  await savedReview(page);
  await page.getByTestId("native-cross-review").click();
  await page.getByRole("button", { name: "교차검토 실행", exact: true }).click();
  await page.getByRole("button", { name: "채팅에서 이어가기", exact: true }).click();
  await expect(page.getByTestId("native-review-chat-preview")).toContainText("선택한 검토자");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "AI 교차검토", exact: true })).toBeVisible();
});
