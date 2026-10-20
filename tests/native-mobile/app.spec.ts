import { expect, test, type Page } from "@playwright/test";
const pageErrors = new WeakMap<Page, string[]>();

async function signIn(page: Page) {
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox").fill(text);
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await expect(page.getByRole("button", { name: "답변 중지" })).toBeVisible();
  await expect(page.getByRole("button", { name: "메시지 보내기", exact: true })).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "ko"); localStorage.setItem("tomverse-theme", "light"); });
  await page.route("https://tomverse.app/**", (route) => route.abort("blockedbyclient"));
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test("first answer, follow-up and tab termination restore the saved conversation", async ({ page, context }) => {
  await signIn(page); await send(page, "첫 질문입니다"); await send(page, "후속 질문입니다");
  await expect(page.locator("article.user")).toHaveCount(2);
  await expect(page.locator("article.assistant")).toHaveCount(2);
  await page.close(); const reopened = await context.newPage(); await reopened.goto("/");
  await expect(reopened.locator("article.user")).toHaveCount(2);
  await expect(reopened.locator("article.assistant")).toHaveCount(2);
});

test("Korean composition Enter never dispatches; explicit Send does", async ({ page }) => {
  await signIn(page); const input = page.getByRole("textbox"); await input.fill("한글 입력 중");
  await input.dispatchEvent("compositionstart"); await input.press("Enter");
  await expect(page.locator("article.user")).toHaveCount(0);
  await input.dispatchEvent("compositionend"); await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await expect(page.locator("article.user")).toHaveCount(1);
});

test("stopping requires a server read and never silently resends", async ({ page }) => {
  await signIn(page); await page.getByRole("textbox").fill("중지할 질문");
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await page.getByRole("button", { name: "답변 중지" }).click();
  await expect(page.getByRole("button", { name: "저장된 답변 확인" })).toBeVisible();
  await expect(page.getByRole("button", { name: "메시지 보내기", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "저장된 답변 확인" }).click();
  await expect(page.locator("article.user")).toHaveCount(1);
});

test("Chat draft stays with Chat when viewing Review modes", async ({ page }) => {
  await signIn(page); await page.getByRole("textbox").fill("Chat에만 남을 초안");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByText("Review는 앱에서 준비 중이에요.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Professional", exact: true }).click();
  await expect(page.getByRole("button", { name: "Professional", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Chat에만 남을 초안");
});

test("model sheet searches, applies and traps focus with a working Escape", async ({ page }) => {
  await signIn(page); await page.getByRole("button", { name: "모델 선택", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "모델 선택" }); await expect(sheet).toBeVisible();
  await sheet.getByRole("searchbox").fill("does-not-exist"); await expect(sheet.getByRole("radio")).toHaveCount(0);
  await sheet.getByRole("searchbox").fill("demo"); await sheet.getByRole("radio").check();
  await sheet.getByRole("button", { name: "선택 적용" }).click(); await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: "모델 선택", exact: true }).click(); await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0);
});

test("file selection is not a send and its reference survives a reload", async ({ page }) => {
  await signIn(page);
  await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic input only") });
  await expect(page.getByRole("button", { name: "첨부파일 제거: synthetic.txt" })).toBeVisible();
  await expect(page.locator("article.user")).toHaveCount(0);
  await send(page, "첨부를 읽어 주세요"); await page.reload();
  await expect(page.locator("article.user").getByText("synthetic.txt", { exact: true })).toBeVisible();
});

test("voice returns mixed-language editable text without a chat send", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]); await signIn(page);
  await page.getByRole("button", { name: "음성 녹음", exact: true }).click();
  const finish = page.getByRole("button", { name: "녹음 완료", exact: true }); await expect(finish).toBeEnabled();
  await page.waitForTimeout(1200); await finish.click();
  await expect(page.getByRole("textbox")).toHaveValue(/Hello, 안녕하세요/);
  await expect(page.locator("article.user")).toHaveCount(0);
});

test("microphone refusal leaves typed input usable", async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Denied", "NotAllowedError"); }; });
  await signIn(page); await page.getByRole("button", { name: "음성 녹음", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("마이크를 사용할 수 없습니다");
  await page.getByRole("textbox").fill("입력은 계속 가능"); await expect(page.getByRole("button", { name: "메시지 보내기", exact: true })).toBeEnabled();
});

test("sign-out removes previous account drafts and saved conversations", async ({ page }) => {
  await signIn(page); await send(page, "이전 계정의 질문"); await page.getByRole("textbox").fill("비공개 초안");
  await page.getByRole("button", { name: "언어와 화면", exact: true }).click(); await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.locator("article")).toHaveCount(0); await expect(page.getByRole("textbox")).toHaveValue("");
});

for (const width of [320, 390, 768, 1024, 1440]) test(`light/dark layout and controls remain visible at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await expect(page.getByRole("button", { name: "파일 첨부", exact: true })).toBeInViewport();
    await expect(page.locator(".empty-chat .icon-logo")).toBeVisible();
    expect(await page.locator(".empty-chat .icon-logo").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
});
