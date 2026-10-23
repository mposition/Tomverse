import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const output = resolve(process.cwd(), "../../.tmp/native-parity");
mkdirSync(output, { recursive: true });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "ko"); localStorage.setItem("tomverse-theme", "dark"); });
  await page.route("https://tomverse.app/**", route => route.abort());
});
async function signIn(page: Page) { await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click(); await expect(page.getByRole("textbox")).toBeVisible(); }
async function send(page: Page, text: string) { await page.getByRole("textbox").fill(text); await page.getByRole("button", { name: "메시지 보내기", exact: true }).click(); await expect(page.getByRole("button", { name: "답변 중지" })).toBeVisible(); await expect(page.getByRole("button", { name: "메시지 보내기", exact: true })).toBeVisible(); }

test("Smart Adaptive, settings and composer tools use the existing account and conversation controls", async ({ page }) => {
  await signIn(page); await expect(page.getByRole("button", { name: "Smart Adaptive" })).toBeVisible();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "AI 및 개인화", exact: true }).click(); await expect(page.getByRole("switch", { name: "메모리", exact: true })).toBeChecked();
  await page.getByRole("switch", { name: "메모리", exact: true }).uncheck(); await page.getByRole("button", { name: "변경사항 저장" }).click(); await expect(page.getByRole("status")).toContainText("저장했습니다");
  await page.screenshot({ path: resolve(output, "settings-dark.png") });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "파일 첨부", exact: true }).click();
  await expect(page.getByRole("button", { name: "사진 선택" })).toBeVisible();
  await page.getByRole("switch", { name: /웹 검색/ }).check(); await expect(page.getByRole("switch", { name: /웹 검색/ })).toBeChecked();
  await page.getByLabel("어시스턴트", { exact: true }).selectOption("demo-assistant");
  await page.screenshot({ path: resolve(output, "composer-tools-dark.png") });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await send(page, "도구를 사용한 질문"); await expect(page.locator(".message.user .message-label")).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0]);
  expect(saved.webSearchMode).toBe("always"); expect(saved.assistantProfileId).toBe("demo-assistant");
});

test("Review provider tabs never resubmit, follow-ups and reopening restore the same comparison", async ({ page }) => {
  await signIn(page); await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Easy", exact: true })).toHaveAttribute("aria-pressed", "true");
  await send(page, "여러 관점으로 비교해주세요");
  await expect(page.locator("article.user")).toHaveCount(1); await expect(page.getByRole("heading", { name: "Local demo A", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "모델" }).getByRole("button", { name: "Local demo B", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local demo B", exact: true })).toBeVisible();
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0]); expect(saved.messages).toHaveLength(4);
  await send(page, "다음 질문입니다"); await expect(page.locator("article.user")).toHaveCount(2);
  await page.screenshot({ path: resolve(output, "review-results-dark.png") });
  await page.reload(); await page.getByRole("button", { name: "Review", exact: true }).click(); await expect(page.locator("article.user")).toHaveCount(2);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0]); expect(saved.messages).toHaveLength(8);
});

test("cross-review keeps per-quote grounding, reversible feedback and separate web verification consent", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const injection = `
      const result = { consensus: [{ text: "Shared claim", citations: [{ responseId: "A", quote: "A synthetic perspective", verified: true }, { responseId: "B", quote: "Missing quote", verified: false }], verified: false }], differences: [], contradictions: [], missingPoints: [], verificationNeeded: [], modelAssessments: [], synthesis: "", confidence: "medium", limitations: ["Not external verification"], groundingStats: { totalCitations: 2, verifiedCitations: 1 } };
      let cached = null; let verdict = null;
      transport.reviewPreview = async () => ({ available: true, promptMessageId: "question", assistantMessageIds: ["a", "b"], estimatedCredits: 9, ...(cached ? { storedReview: cached } : {}) });
      transport.runComparison = async id => { window.reviewRuns = (window.reviewRuns || 0) + 1; const rows = (await transport.load(id)).messages.filter(m => m.role === "assistant"); cached = { id: "review", result: { primary: { reviewerModelId: "Synthetic reviewer", result }, secondary: null, agreement: null }, responseMap: rows.slice(0,2).map((m,i) => ({responseId:i ? "B" : "A",messageId:m.id,modelId:m.modelId,modelName:m.modelId})), reviewerModelId: "Synthetic reviewer", usageCredits: 9, cached: false, disclaimer: "Compares supplied answers only.", reviewItems: [{id:"server-item",reviewer:"primary",section:"consensus",ordinal:0}] }; return cached; };
      transport.reviewFeedback = async () => ({ feedback: verdict ? [{reviewItemId:"server-item",verdict}] : [] });
      transport.setReviewFeedback = async (id,reviewId,itemId,value) => { verdict = value; };
      transport.verifyReviewItem = async () => { window.verifyRuns = (window.verifyRuns || 0) + 1; return {status:"inconclusive",summary:"Synthetic result",usageCredits:2,reviewerModelId:"Synthetic web reviewer",disclaimer:"Not a truth guarantee"}; };
    `;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await signIn(page); await page.getByRole("button", { name: "Review", exact: true }).click(); await send(page, "Compare");
  await page.getByRole("button", { name: "AI 교차검토", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { reviewRuns?: number }).reviewRuns ?? 0)).toBe(0);
  await page.getByRole("button", { name: "교차검토 실행", exact: true }).click();
  await expect(page.getByText("출처 인용 일치율: 50% (1/2)")).toBeVisible(); await expect(page.getByText(/B · 원문 일치가 확인되지 않은 인용/)).toBeVisible();
  const helpful = page.getByRole("button", { name: "도움 됨", exact: true }); await helpful.click(); await expect(helpful).toHaveAttribute("aria-pressed", "true"); await helpful.click(); await expect(helpful).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "웹에서 확인 · 별도 크레딧" }).click();
  expect(await page.evaluate(() => (window as unknown as { verifyRuns?: number }).verifyRuns ?? 0)).toBe(0);
  await page.getByRole("button", { name: "웹 검증 실행 확인" }).click(); await expect(page.getByText("Synthetic result", { exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(output, "cross-review-dark.png") });
  expect(await page.evaluate(() => (window as unknown as { reviewRuns: number }).reviewRuns)).toBe(1);
});

test("historical generated images renew an expired signed URL without exposing storage keys", async ({ page }) => {
  await page.route("https://fixture.invalid/expired.png", route => route.fulfill({ status: 403 }));
  await page.route("https://fixture.invalid/image.png", route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3sAAAAASUVORK5CYII=", "base64") }));
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const injection = `const baseLoad = transport.load; let imageReads = 0;
      transport.load = async id => { const item = await baseLoad(id); return {...item,messages:item.messages.map(m=>m.role === "assistant"?{...m,content:"[Image generated]",imageTurn:{groupId:"synthetic-group",modelIds:["demo"]}}:m)}; };
      transport.imageGroup = async () => { imageReads++; window.imageReads = imageReads; return {status:"succeeded",targets:[{targetId:"target",modelId:"demo",currentGenerationId:"generation"}],generations:[{generationId:"generation",status:"succeeded",prompt:"Synthetic image",assets:[{role:"original",url:imageReads === 1?"https://fixture.invalid/expired.png":"https://fixture.invalid/image.png",urlExpiresAt:imageReads === 1?"2000-01-01T00:00:00Z":"2099-01-01T00:00:00Z"}]}]}; };`;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await signIn(page); await send(page, "Show existing image");
  const image = page.getByRole("img", { name: "Synthetic image", exact: true }); await expect(image).toHaveAttribute("src", "https://fixture.invalid/image.png");
  expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText("[Image generated]", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { imageReads: number }).imageReads)).toBe(2);
  await page.reload(); await expect(image).toHaveAttribute("src", "https://fixture.invalid/image.png");
});

test("image quotes require fresh consent after a price change and never run automatically", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const injection = `let capReads=0; transport.mobileCapabilities=async()=>{capReads++;return {reviewEasy:true,assistants:false,maxModels:3,plan:"Max",images:{enabled:true,maxModels:3,models:[{id:"synthetic-image",name:"Synthetic image model",provider:"openai",pricingVersion:window.priceChanged?"v2":"v1",prices:[{quality:"medium",size:"1024x1024",credits:window.priceChanged?12:10}]}]}};};
      transport.generateImages=async()=>{window.imageRuns=(window.imageRuns||0)+1;return {groupId:"group",conversationId:"image-chat"};};
      transport.imageGroup=async()=>({status:"failed",targets:[],generations:[]});`;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await signIn(page); await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "이미지 스튜디오", exact: true }).click(); await page.getByLabel("이미지 설명").fill("Synthetic prompt");
  expect(await page.evaluate(() => (window as unknown as { imageRuns?: number }).imageRuns ?? 0)).toBe(0);
  const consent = page.getByRole("checkbox", { name: /선택한 모델과 표시된 크레딧/ }); await consent.check(); await page.evaluate(() => { (window as unknown as { priceChanged: boolean }).priceChanged = true; }); await page.getByRole("button", { name: "이미지 생성", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("모델 또는 가격이 변경되었습니다"); await expect(consent).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { imageRuns?: number }).imageRuns ?? 0)).toBe(0);
  await consent.check(); await page.getByRole("button", { name: "이미지 생성", exact: true }).click();
  await expect(consent).not.toBeChecked(); expect(await page.evaluate(() => (window as unknown as { imageRuns: number }).imageRuns)).toBe(1);
});

test("a long file selection preserves the draft behind the lock and resumes upload only after unlock", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const injection = `
      transport.deviceSecurity=async()=>({enabled:true,available:true,locked:window.fixtureLocked===true});
      transport.unlockDevice=async()=>{window.fixtureLocked=false;};
      const priorSignOut=transport.signOut;transport.signOut=async()=>{await priorSignOut();window.fixtureLocked=false;};
      const {deviceAccessGrant}=await import('/src/deviceUnlock.ts');
      transport.upload=async file=>{await deviceAccessGrant({getAccessToken:async()=>{if(window.fixtureLocked)throw {code:'DEVICE_LOCKED'};return {accessToken:'synthetic',expiresAt:Date.now()+600000};},getDeviceSecurity:transport.deviceSecurity},{},undefined,window);window.uploadCompletions=(window.uploadCompletions||0)+1;return {uploadId:'receipt',name:file.name,mediaType:file.type,size:file.size};};`;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await signIn(page); await page.getByRole("textbox").fill("Preserve my draft");
  await page.evaluate(() => { (window as unknown as { fixtureLocked: boolean }).fixtureLocked = true; });
  await page.getByTestId("photo-picker").setInputFiles({ name: "long-selection.png", mimeType: "image/png", buffer: Buffer.from("synthetic") });
  await expect(page.getByText("대화가 잠겨 있습니다", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { uploadCompletions?: number }).uploadCompletions ?? 0)).toBe(0);
  await page.getByRole("button", { name: "Tomverse 잠금 해제" }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Preserve my draft"); await expect(page.getByRole("button", { name: "첨부파일 제거: long-selection.png" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { uploadCompletions: number }).uploadCompletions)).toBe(1);
  await page.evaluate(() => { (window as unknown as { fixtureLocked: boolean }).fixtureLocked = true; window.dispatchEvent(new Event("tomverse-device-security-changed")); });
  await page.getByRole("button", { name: "로그아웃", exact: true }).click(); await expect(page.getByRole("button", { name: "Tomverse로 계속" })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
});
