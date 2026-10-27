import { selectProduct } from "./workspaceNavigation";
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
  await page.getByRole("button", { name: "대화", exact: true }).click(); await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "AI 개인화", exact: true }).click(); await page.getByRole("button", { name: "계정 장기 기억", exact: true }).click(); await expect(page.getByRole("switch", { name: "메모리", exact: true })).toBeChecked();
  await page.getByRole("switch", { name: "메모리", exact: true }).uncheck(); await page.getByRole("button", { name: "변경사항 저장" }).click(); await expect(page.getByRole("status")).toContainText("저장했습니다");
  await page.screenshot({ path: resolve(output, "settings-dark.png") });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "파일 첨부", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("메모리", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "사진 선택" })).toBeVisible();
  await expect(page.getByRole("switch", { name: /웹 검색/ })).toBeChecked();
  await page.getByRole("switch", { name: /웹 검색/ }).uncheck();
  await expect(page.getByRole("switch", { name: /웹 검색/ })).not.toBeChecked();
  await page.getByRole("switch", { name: /웹 검색/ }).check(); await expect(page.getByRole("switch", { name: /웹 검색/ })).toBeChecked();
  await page.getByLabel("어시스턴트", { exact: true }).selectOption("demo-assistant");
  await page.screenshot({ path: resolve(output, "composer-tools-dark.png") });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await send(page, "도구를 사용한 질문"); await expect(page.locator(".message.user .message-label")).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0]);
  expect(saved.webSearchMode).toBe("always"); expect(saved.assistantProfileId).toBe("demo-assistant");
  const memory = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo:memory")!));
  expect(memory.masterEnabled).toBe(false);
});

test("Review provider tabs never resubmit, follow-ups and reopening restore the same comparison", async ({ page }) => {
  await signIn(page); await selectProduct(page, "review");
  await expect(page.getByRole("button", { name: /참여 모델 선택 · Easy/ })).toBeVisible();
  await send(page, "여러 관점으로 비교해주세요");
  await expect(page.locator("article.user")).toHaveCount(1); await expect(page.getByRole("heading", { name: "Local demo A", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "모델", exact: true }).selectOption("demo-b");
  await expect(page.getByRole("heading", { name: "Local demo B", exact: true })).toBeVisible();
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0]); expect(saved.messages).toHaveLength(4);
  await send(page, "다음 질문입니다"); await expect(page.locator("article.user")).toHaveCount(2);
  const geometry = await page.evaluate(() => ({ height: innerHeight, conversation: document.querySelector(".review-transcript")!.getBoundingClientRect().height, composer: document.querySelector(".composer-area")!.getBoundingClientRect().height }));
  expect(geometry.conversation / geometry.height).toBeGreaterThan(0.72);
  expect(geometry.composer).toBeLessThanOrEqual(164);
  await page.screenshot({ path: resolve(output, "review-conversation-dark-v2.png") });
  await page.reload(); await selectProduct(page, "review"); await expect(page.getByTestId("review-landing")).toBeVisible();
  await page.getByRole("button", { name: "대화", exact: true }).click(); await page.locator(".conversation-row").click(); await expect(page.locator("article.user")).toHaveCount(2);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0]); expect(saved.messages).toHaveLength(8);
});

test("Review message tools omit cross-review and image studio actions", async ({ page }) => {
  await signIn(page); await selectProduct(page, "review");
  await send(page, "Compare these options");
  await page.getByRole("button", { name: "파일 첨부", exact: true }).click();
  const tools = page.getByRole("dialog");
  await expect(tools.getByRole("button", { name: "AI 교차검토", exact: true })).toHaveCount(0);
  await expect(tools.getByRole("button", { name: "이미지 스튜디오", exact: true })).toHaveCount(0);
  await expect(tools.getByRole("button", { name: "사진 선택", exact: true })).toBeVisible();
  await expect(tools.getByRole("switch", { name: /웹 검색/ })).toBeVisible();
  await page.screenshot({ path: resolve(output, "review-tools-dark.png") });
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
  await page.reload(); await page.getByRole("button", { name: "대화", exact: true }).click(); await page.locator(".conversation-row").click();
  await expect(image).toHaveAttribute("src", "https://fixture.invalid/image.png");
});

test("image quotes require fresh consent after a price change and never run automatically", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const injection = `let capReads=0; transport.mobileCapabilities=async()=>{capReads++;return {reviewEasy:true,assistants:false,maxModels:3,plan:"Max",images:{enabled:true,maxModels:3,models:[{id:"synthetic-image",name:"Synthetic image model",provider:"openai",pricingVersion:window.priceChanged?"v2":"v1",prices:[{quality:"medium",size:"1024x1024",credits:window.priceChanged?12:10}]}]}};};
      transport.routeReview=async()=>({kind:"image",preset:"standard",choices:[{provider:"openai",modelId:"synthetic-image"}]});
      transport.generateImages=async()=>{window.imageRuns=(window.imageRuns||0)+1;return {groupId:"group",conversationId:"image-chat"};};
      transport.imageGroup=async()=>({status:"failed",targets:[],generations:[]});`;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await signIn(page); await selectProduct(page, "review");
  await page.getByRole("textbox").fill("Synthetic image prompt");
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await page.getByLabel("이미지 설명").fill("Synthetic prompt");
  expect(await page.evaluate(() => (window as unknown as { imageRuns?: number }).imageRuns ?? 0)).toBe(0);
  const consent = page.getByRole("checkbox", { name: /선택한 모델과 표시된 크레딧/ }); await consent.check(); await page.evaluate(() => { (window as unknown as { priceChanged: boolean }).priceChanged = true; }); await page.getByRole("button", { name: "이미지 생성", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("모델 또는 가격이 변경되었습니다"); await expect(consent).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { imageRuns?: number }).imageRuns ?? 0)).toBe(0);
  await consent.check(); await page.getByRole("button", { name: "이미지 생성", exact: true }).click();
  await expect(consent).not.toBeChecked(); expect(await page.evaluate(() => (window as unknown as { imageRuns: number }).imageRuns)).toBe(1);
});

test("returning from a long file selection never introduces a device unlock", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const injection = `transport.deviceSecurity=async()=>({enabled:true,available:true,locked:false});transport.unlockDevice=async()=>{throw Error("Unexpected unlock");};`;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await signIn(page); await page.getByRole("textbox").fill("Preserve my draft");
  await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("tomverse-device-security-changed")); });
  await page.getByTestId("photo-picker").setInputFiles({ name: "long-selection.png", mimeType: "image/png", buffer: Buffer.from("synthetic") });
  await expect(page.getByRole("textbox")).toHaveValue("Preserve my draft");
  await expect(page.getByRole("button", { name: "첨부파일 제거: long-selection.png" })).toBeVisible();
  await expect(page.getByText("대화가 잠겨 있습니다", { exact: true })).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("textbox")).toHaveValue("Preserve my draft");
});

for (const recovery of ["receipt", "same-request", 400, 401, 403, 409, 422, 429] as const) test(`lost image responses recover or explicitly close after ${recovery}`, async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const injection = `transport.mobileCapabilities=async()=>({reviewEasy:true,assistants:false,maxModels:3,plan:"Max",images:{enabled:true,maxModels:1,models:[{id:"synthetic-image",name:"Synthetic image model",provider:"openai",pricingVersion:"v1",prices:[{quality:"medium",size:"1024x1024",credits:10}]}]}});
      transport.routeReview=async()=>({kind:"image",preset:"standard",choices:[{provider:"openai",modelId:"synthetic-image"}]});
      window.imageRequests=[];transport.generateImages=async input=>{window.imageRequests.push(input);if(window.imageRequests.length===1)throw new TypeError("Lost response");${typeof recovery === "number" ? `throw {status:${recovery}};` : 'return {groupId:"saved-group",conversationId:"image-chat"};'}};
      transport.imageRequest=async key=>{window.receiptKey=key;if(window.receiptAvailable) return {groupId:"saved-group",conversationId:"image-chat"};${recovery === "receipt" ? 'return {groupId:"saved-group",conversationId:"image-chat"};' : 'throw {status:404};'}};
      transport.imageGroup=async()=>({status:"failed",targets:[],generations:[]});`;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await signIn(page); await selectProduct(page, "review");
  await page.getByRole("textbox").fill("Synthetic image prompt");
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await page.getByLabel("이미지 설명").fill("Keep the same image request");
  const consent = page.getByRole("checkbox", { name: /선택한 모델과 표시된 크레딧/ }); await consent.check(); await page.getByRole("button", { name: "이미지 생성", exact: true }).click();
  await expect(page.getByLabel("이미지 설명")).toBeDisabled();
  await expect(page.getByRole("button",{name:"보류 중인 요청 닫기",exact:true})).toHaveCount(0);
  const first = await page.evaluate(() => (window as unknown as { imageRequests: Array<{idempotencyKey:string}> }).imageRequests[0]);
  await page.getByRole("button", { name: "저장된 결과 조회", exact: true }).click();
  if (recovery !== "receipt") {
    await consent.check(); await page.getByRole("button", { name: "같은 요청 확인 후 계속", exact: true }).click();
  }
  if (typeof recovery === "number") {
    await expect(consent).not.toBeChecked(); await expect(page.getByLabel("이미지 설명")).toBeDisabled();
    const savedKey=await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-image-pending:synthetic-demo")!).idempotencyKey);expect(savedKey).toBe(first.idempotencyKey);
    await expect(page.getByRole("button", { name: "이미지 생성", exact: true })).toBeDisabled();
    if ([400,403,422].includes(recovery)) {
      await page.getByRole("button",{name:"보류 중인 요청 닫기",exact:true}).click();
      const close=page.getByRole("button",{name:"닫고 새 요청 작성 허용",exact:true});await expect(close).toBeDisabled();
      await page.getByRole("checkbox",{name:"새 요청에는 크레딧이 별도로 사용될 수 있음을 이해했습니다."}).check();await close.click();
      await expect(consent).not.toBeChecked();await expect(page.getByRole("button",{name:"이미지 생성",exact:true})).toBeDisabled();
    } else {
      await expect(page.getByRole("button",{name:"보류 중인 요청 닫기",exact:true})).toHaveCount(0);
      await page.evaluate(() => { (window as unknown as {receiptAvailable:boolean}).receiptAvailable=true; });
      await page.getByRole("button", { name: "저장된 결과 조회", exact: true }).click();
    }
  }
  await expect(page.getByLabel("이미지 설명")).toBeEnabled();
  const requests = await page.evaluate(() => (window as unknown as { imageRequests: Array<{idempotencyKey:string}> }).imageRequests);
  expect(requests).toHaveLength(recovery === "receipt" ? 1 : 2); expect(requests.every(input => input.idempotencyKey === first.idempotencyKey)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("tomverse-image-pending:synthetic-demo"))).toBeNull();
});

for (const mode of ["Easy", "Professional"] as const) test(`missing ${mode} Review participants keeps the attachment and draft editable`, async ({ page }) => {
  await signIn(page);await selectProduct(page, "review");
  await page.getByTestId("file-picker").setInputFiles({name:"keep.txt",mimeType:"text/plain",buffer:Buffer.from("Keep")});
  await expect(page.getByRole("button",{name:"첨부파일 제거: keep.txt"})).toBeVisible();
  await page.getByRole("textbox").fill("Keep my question");await page.getByRole("button",{name:/참여 모델 선택/}).click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("button", { name: mode, exact: true }).click();
  const options = picker.getByRole("checkbox");
  await expect(options).toHaveCount(3);
  for (const checkbox of await options.all()) { await checkbox.uncheck(); await expect(checkbox).not.toBeChecked(); }
  await page.getByRole("button",{name:"닫기",exact:true}).click();await page.getByRole("button",{name:"메시지 보내기",exact:true}).click();
  await expect(page.getByRole("alert")).toBeVisible();await expect(page.getByRole("textbox")).toHaveValue("Keep my question");
  await expect(page.getByRole("button",{name:"첨부파일 제거: keep.txt"})).toBeVisible();await expect(page.locator("article.user")).toHaveCount(0);
});

test("a refused Review admission preserves the draft and selected attachment without a saved question", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response=await route.fetch();const source=await response.text();
    await route.fulfill({response,body:source.replace("createRoot(container).render(", 'transport.sendReview=async()=>{throw Object.assign(new Error("CHAT_RATE_LIMITED"),{status:429,code:"CHAT_RATE_LIMITED",questionPersisted:false,retryAfterSeconds:12,traceId:"synthetic-trace"});};createRoot(container).render(')});
  });
  await signIn(page);await selectProduct(page, "review");
  await page.getByTestId("file-picker").setInputFiles({name:"keep.txt",mimeType:"text/plain",buffer:Buffer.from("Keep this attachment")});
  await expect(page.getByRole("button",{name:"첨부파일 제거: keep.txt"})).toBeVisible();
  await page.getByRole("textbox").fill("Keep my question");await page.getByRole("button",{name:"메시지 보내기",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("12초 후");await expect(page.getByRole("alert")).toContainText("Trace ID: synthetic-trace");await expect(page.getByRole("textbox")).toHaveValue("Keep my question");
  await expect(page.getByRole("button",{name:"첨부파일 제거: keep.txt"})).toBeVisible();await expect(page.locator("article.user")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"메시지 보내기",exact:true})).toBeEnabled();
});

test("microphone device failure does not tell an already permitted user to grant access again", async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("In use", "NotReadableError"); }; });
  await signIn(page); await page.getByRole("button", { name: "음성 녹음", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("다른 녹음 앱을 종료하고");
  await expect(page.getByRole("alert")).not.toContainText("권한");
});

test("voice server refusal retains its cause and never submits the draft", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", 'transport.transcribe=async()=>{throw {status:503,code:"VOICE_INPUT_DISABLED"};};createRoot(container).render(') });
  });
  await signIn(page); await page.getByRole("button", { name: "음성 녹음", exact: true }).click();
  const finish = page.getByRole("button", { name: "녹음 완료", exact: true }); await expect(finish).toBeEnabled();
  await expect(page.locator(".voice-privacy")).toContainText("Tomverse는 녹음을 저장하지 않으며");
  await page.waitForTimeout(1200); await finish.click();
  await expect(page.getByRole("alert")).toContainText("현재 서버에서 음성 입력을 사용할 수 없습니다");
  await expect(page.locator("article.user")).toHaveCount(0);
});

test("an answer can be reported from the app, and the report names that answer", async ({ page }) => {
  await signIn(page); await send(page, "신고할 답변을 만들어 줘");
  const report = page.getByTestId("answer-report").last();
  await expect(report).toHaveText("해당 답변의 문제 신고");
  await report.click();
  const dialog = page.getByRole("dialog", { name: "해당 답변의 문제 신고" });
  await dialog.getByRole("textbox").fill("짧음");
  await dialog.getByRole("button", { name: "신고 보내기" }).click();
  await expect(dialog.getByRole("alert")).toContainText("5자 이상");
  await dialog.getByRole("textbox").fill("카페인 설명이 틀렸습니다.");
  await dialog.getByRole("button", { name: "신고 보내기" }).click();
  await expect(dialog.getByRole("status")).toContainText("신고를 보냈습니다");
  await expect(dialog.getByRole("status")).toContainText("접수 번호 TV-DEMO-1");
  await page.screenshot({ path: resolve(output, "answer-report-dark.png") });
  const reports = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo:reports") ?? "[]"));
  expect(reports).toHaveLength(1);
  expect(reports[0].message).toBe("카페인 설명이 틀렸습니다.");
  const answers = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0].messages.filter((m: { role: string }) => m.role === "assistant").map((m: { id: string }) => m.id));
  expect(answers).toContain(reports[0].messageId);
});
