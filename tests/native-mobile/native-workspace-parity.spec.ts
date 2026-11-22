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

type SavedReviewOptions = { draft?: string | null; draftFile?: boolean; failDraftStorage?: boolean; surface?: string };
async function savedReview(page: Page, changed = false, refusal?: number, options: SavedReviewOptions = {}) {
  const fixture = makeReviewReportFixture();
  // Server item identities (never recomputed on the client) for the secondary reviewer's first consensus item.
  fixture.review.reviewItems = [{ id: "server-item-secondary-0", reviewer: "secondary", section: "consensus", ordinal: 0 }];
  await page.addInitScript(({ draftFile, failDraftStorage }) => {
    if (draftFile) localStorage.setItem("tomverse-device-draft:synthetic-demo:new:files", JSON.stringify({ files: [{ uploadId: "upload_plan", name: "plan.pdf", mediaType: "application/pdf", size: 1200 }], savedAt: Date.now() }));
    if (failDraftStorage) {
      // Device draft storage fails (quota, privacy mode); the in-memory draft must survive.
      const { getItem, setItem } = Storage.prototype;
      Storage.prototype.setItem = function (key: string, value: string) { if (key.startsWith("tomverse-device-draft:")) throw new DOMException("Quota", "QuotaExceededError"); return setItem.call(this, key, value); };
      Storage.prototype.getItem = function (key: string) { if (key.startsWith("tomverse-device-draft:")) throw new DOMException("Blocked", "SecurityError"); return getItem.call(this, key); };
    }
  }, { draftFile: options.draftFile, failDraftStorage: options.failDraftStorage });
  await page.addInitScript(({ source, surface }) => {
    localStorage.setItem("tomverse-native-synthetic-demo", JSON.stringify([{ id: source.conversationId, title: "Saved comparison", surface: surface ?? "workspace", productKey: "review", selectedModels: ["demo", "demo-b"], messages: [
      { id: "prompt-1", role: "user", content: source.setup.source!.question },
      ...source.setup.source!.responses.map((answer, index) => ({ id: answer.messageId, role: "assistant", modelId: index ? "demo-b" : "demo", content: answer.content, status: "normal" })),
    ] }]));
  }, { source: fixture, surface: options.surface });
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const source = await response.text();
    const injection = `const fixture=${JSON.stringify(fixture)};let paid=0;let cached=false;
      const bump=key=>localStorage.setItem(key,String(Number(localStorage.getItem(key)??'0')+1));
      const hold=signal=>window.holdReadback?new Promise((resolve,reject)=>{window.releaseReadback=resolve;signal?.addEventListener('abort',()=>{localStorage.setItem('readback-aborted','1');reject(new DOMException('Aborted','AbortError'));},{once:true});}):Promise.resolve();
      transport.reviewPreview=async(id,mode,synthesis,signal)=>{bump('review-reads');await hold(signal);return {...fixture.setup,estimatedCredits:0.2,assistantMessageIds:["answer-a","answer-b"],storedReview:cached?fixture.review:undefined};};
      const create=transport.create;transport.create=async(...args)=>{bump('chat-creates');return create(...args);};
      const send=transport.send;transport.send=async(conversation,text,files,...rest)=>{const rows=JSON.parse(localStorage.getItem('chat-sends')??'[]');rows.push({text,files:files.map(file=>file.name)});localStorage.setItem('chat-sends',JSON.stringify(rows));return send(conversation,text,files,...rest);};
      transport.runComparison=async()=>{paid++;localStorage.setItem('analysis-paid-calls',String(paid));cached=true;return fixture.review;};
      transport.quickSummaryPreview=async()=>({available:true,estimatedCredits:0.1,cached,source:fixture.setup.source,storedSummary:cached?{id:'quick-1',reviewerModelId:'reviewer-a',responseMap:fixture.review.responseMap,result:{commonConclusions:fixture.review.result.primary.result.consensus,importantDifferences:[],modelKeyClaims:[],verificationNeeded:['Check dates.']}}:undefined});
      transport.runQuickSummary=async()=>{paid++;localStorage.setItem('analysis-paid-calls',String(paid));${refusal ? `throw Object.assign(Error('Refused'),{status:${refusal}});` : "cached=true;return {};"}};
      ${changed ? "const original=transport.quickSummaryPreview;transport.quickSummaryPreview=async()=>{const value=await original();if(window.reviewSourceChanged)value.source={...value.source,question:'Changed question'};return value;};" : ""}
      `;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", `${injection}createRoot(container).render(`) });
  });
  await signIn(page);
  const draft = options.draft === undefined ? "Keep my original draft" : options.draft;
  if (draft !== null) await page.getByRole("textbox").fill(draft);
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
  await page.evaluate(() => sessionStorage.setItem("tomverse-native-review-handoff-target", "stale"));
  await page.getByRole("button", { name: "기존 초안에 추가", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue(/^Keep my original draft\n\n비교 참고 자료/);
  await expect(page.locator("article.user")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("analysis-paid-calls"))).toBe("1");
  expect(await page.evaluate(() => sessionStorage.getItem("tomverse-native-review-handoff-target"))).toBeNull();
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

test("a source changed after preview cannot overwrite the Chat draft", async ({ page }) => {
  await savedReview(page, true);
  await page.getByTestId("native-quick-summary").click();
  await page.getByRole("button", { name: "차이 요약 실행", exact: true }).click();
  await page.getByRole("button", { name: "채팅에서 이어가기", exact: true }).click();
  await page.evaluate(() => { (window as unknown as { reviewSourceChanged: boolean }).reviewSourceChanged = true; });
  await page.getByRole("button", { name: "기존 초안에 추가", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("접근 권한을 확인하지 못했습니다");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await selectProduct(page, "chat");
  await expect(page.getByRole("textbox")).toHaveValue("Keep my original draft");
});

test("an explicit credit refusal clears the pending lock and keeps summary retry available", async ({ page }) => {
  await savedReview(page, false, 402);
  await page.getByTestId("native-quick-summary").click();
  const run = page.getByRole("button", { name: "차이 요약 실행", exact: true });
  await run.click();
  await expect(page.getByRole("alert")).toContainText("저장된 응답은 유지됩니다");
  await expect(run).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("tomverse-quick-summary-pending:synthetic-demo:qa-conversation"))).toBeNull();
});

const stored = (page: Page, key: string) => page.evaluate(name => localStorage.getItem(name), key);
async function runCrossReview(page: Page) {
  await page.getByTestId("native-cross-review").click();
  await page.getByRole("button", { name: "교차검토 실행", exact: true }).click();
  await expect(page.getByRole("button", { name: "채팅에서 이어가기", exact: true })).toBeVisible();
}
async function runQuickSummary(page: Page) {
  await page.getByTestId("native-quick-summary").click();
  await page.getByRole("button", { name: "차이 요약 실행", exact: true }).click();
  await expect(page.getByRole("button", { name: "채팅에서 이어가기", exact: true })).toBeVisible();
}

test("one secondary-reviewer item becomes an unsent draft and only the user's Send carries the edited text once", async ({ page }) => {
  await savedReview(page);
  await runCrossReview(page);
  await page.getByRole("dialog", { name: "AI 교차검토" }).getByRole("button", { name: "reviewer-b", exact: true }).click();
  await page.getByTestId("native-review-item-continue").first().click();
  const preview = page.getByTestId("native-review-chat-preview");
  await expect(preview).toContainText("두 번째 검토자의 별도 견해");
  await expect(preview).toContainText("reviewer-b (secondary)");
  await expect(preview).toContainText("A: Model A (answer-a)");
  await expect(preview).toContainText("미확인 사항과 한계");
  await expect(preview).toContainText("독립적인 사본");
  await expect(preview).not.toContainText("승인 전에는 배포하지 않습니다");
  await expect(preview).not.toContainText("PRIVATE_FULL_ANSWER");
  await expect(preview).not.toContainText(/^models:/m);
  await page.getByRole("textbox", { name: "다음에 무엇을 하고 싶으신가요?" }).fill("체크리스트로 정리해줘");
  await page.getByTestId("native-review-chat-existing").getByText("현재 새 채팅 초안").click();
  await expect(page.getByTestId("native-review-chat-existing")).toContainText("Keep my original draft");
  await page.getByRole("button", { name: "기존 초안에 추가", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "무엇이든 물어보세요…" });
  await expect(composer).toHaveValue(/^Keep my original draft\n\n비교 참고 자료[\s\S]*두 번째 검토자의 별도 견해[\s\S]*체크리스트로 정리해줘$/);
  // Handoff alone: no Chat, message or provider request, and no new analysis run.
  expect(await stored(page, "chat-creates")).toBeNull();
  expect(await stored(page, "chat-sends")).toBeNull();
  expect(await stored(page, "analysis-paid-calls")).toBe("1");
  await expect(page.locator("article.user")).toHaveCount(0);
  const edited = `${await composer.inputValue()}\n마감일도 넣어줘`;
  await composer.fill(edited);
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await expect(page.locator("article.user")).toHaveCount(1);
  await expect(page.locator("article.user")).toContainText("마감일도 넣어줘");
  expect(await stored(page, "chat-creates")).toBe("1");
  const sends = JSON.parse(await stored(page, "chat-sends") ?? "[]") as Array<{ text: string; files: string[] }>;
  expect(sends).toEqual([{ text: edited, files: [] }]);
  expect(sends[0]!.text.split("비교 참고 자료").length - 1).toBe(1);
  await expect(page.locator("article.assistant").last()).toContainText("local demo response");
  const saved = await page.evaluate(() => (JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo") ?? "[]") as Array<{ id: string; messages: Array<{ role: string; content: string }> }>));
  const chat = saved.find(row => row.id !== "qa-conversation")!;
  expect(chat.messages.filter(message => message.role === "user").map(message => message.content)).toEqual([edited]);
  expect(saved.find(row => row.id === "qa-conversation")!.messages).toHaveLength(3);
  expect(await stored(page, "analysis-paid-calls")).toBe("1");
});

test("an attachment-only new Chat draft needs an explicit Add and keeps its file", async ({ page }) => {
  await savedReview(page, false, undefined, { draft: null, draftFile: true });
  await runQuickSummary(page);
  await page.getByTestId("native-quick-item-continue").first().click();
  await expect(page.getByTestId("native-review-chat-existing")).toContainText("이미 채팅 초안이 있습니다");
  await expect(page.getByTestId("native-review-chat-existing")).toContainText("초안에 첨부된 파일은 그대로 유지됩니다: 1개");
  await expect(page.getByRole("button", { name: "채팅 초안 열기", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "기존 초안에 추가", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "무엇이든 물어보세요…" })).toHaveValue(/^비교 참고 자료[\s\S]*공통 결론/);
  await expect(page.locator(".attachments")).toContainText("plan.pdf");
  expect(await stored(page, "chat-creates")).toBeNull();
});

test("cancelling a pending source check aborts it, ignores its answer and keeps the draft", async ({ page }) => {
  await savedReview(page);
  await runCrossReview(page);
  await page.getByRole("button", { name: "채팅에서 이어가기", exact: true }).click();
  const reads = Number(await stored(page, "review-reads"));
  await page.evaluate(() => { (window as unknown as { holdReadback: boolean }).holdReadback = true; });
  await page.getByRole("button", { name: "기존 초안에 추가", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "저장된 결과를 확인하고 있습니다" })).toBeVisible();
  expect(Number(await stored(page, "review-reads"))).toBe(reads + 1);
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByTestId("native-review-chat-preview")).toHaveCount(0);
  expect(await stored(page, "readback-aborted")).toBe("1");
  await page.evaluate(() => { const w = window as unknown as { holdReadback: boolean; releaseReadback?: () => void }; w.holdReadback = false; w.releaseReadback?.(); });
  await page.getByRole("dialog", { name: "AI 교차검토" }).getByRole("button", { name: "닫기", exact: true }).click();
  await selectProduct(page, "chat");
  await expect(page.getByRole("textbox")).toHaveValue("Keep my original draft");
  expect(await stored(page, "analysis-paid-calls")).toBe("1");
  expect(await stored(page, "chat-creates")).toBeNull();
});

test("failing draft storage keeps the in-memory draft and a double click applies the offer once", async ({ page }) => {
  await savedReview(page, false, undefined, { failDraftStorage: true });
  await runQuickSummary(page);
  await page.getByRole("button", { name: "채팅에서 이어가기", exact: true }).click();
  await expect(page.getByTestId("native-review-chat-existing")).toContainText("이미 채팅 초안이 있습니다");
  await page.getByRole("button", { name: "기존 초안에 추가", exact: true }).dblclick();
  const composer = page.getByRole("textbox", { name: "무엇이든 물어보세요…" });
  await expect(composer).toHaveValue(/^Keep my original draft\n\n비교 참고 자료/);
  expect((await composer.inputValue()).split("비교 참고 자료").length - 1).toBe(1);
});

test("a draft that would exceed the Chat limit is refused, never truncated", async ({ page }) => {
  await savedReview(page, false, undefined, { draft: "x".repeat(39_900) });
  await runQuickSummary(page);
  await page.getByRole("button", { name: "채팅에서 이어가기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("선택 내용이 너무 깁니다");
  await expect(page.getByRole("button", { name: "기존 초안에 추가", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await selectProduct(page, "chat");
  expect((await page.getByRole("textbox").inputValue()).length).toBe(39_900);
});

test("an imported continuation Review keeps its analysis but offers no Chat continuation", async ({ page }) => {
  await savedReview(page, false, undefined, { surface: "continuation" });
  await page.getByTestId("native-cross-review").click();
  await page.getByRole("button", { name: "교차검토 실행", exact: true }).click();
  await expect(page.getByText("공통점")).toBeVisible();
  await expect(page.getByRole("button", { name: "채팅에서 이어가기", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("native-review-item-continue")).toHaveCount(0);
});
