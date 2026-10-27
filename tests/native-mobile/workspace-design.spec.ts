import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeEnabled();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "ko"); });
  await page.route("https://tomverse.app/**", route => route.abort());
});

for (const width of [320, 390]) for (const theme of ["light", "dark"]) {
  test(`the ${theme} composer preserves reading space and a dedicated input row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => localStorage.setItem("tomverse-theme", theme), theme);
    await signIn(page);
    const input = page.getByRole("textbox");
    const height = () => input.evaluate(node => node.getBoundingClientRect().height);
    expect(await height()).toBe(44);
    const centeredHeader = async () => {
      const header = await page.locator(".app-header").boundingBox();
      const brand = await page.locator(".brand-lockup").boundingBox();
      expect(Math.abs(brand!.x + brand!.width / 2 - header!.x - header!.width / 2)).toBeLessThan(0.6);
      const controls = await page.locator(".app-header > button:not(.brand-lockup), .app-header > select").all();
      for (const control of controls) {
        const box = await control.boundingBox();
        if (box) expect(box.x + box.width <= brand!.x + 1 || box.x >= brand!.x + brand!.width - 1).toBe(true);
      }
    };
    await centeredHeader();
    await input.focus();
    expect(await height()).toBe(44);
    const geometry = await page.locator(".composer-area").evaluate(node => {
      const dock = node.getBoundingClientRect();
      const input = node.querySelector("textarea")!.getBoundingClientRect();
      const controls = node.querySelector(".composer-toolbar")!.getBoundingClientRect();
      return { height: dock.height, inputWidth: input.width, available: dock.width, below: controls.top >= input.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.height).toBeLessThanOrEqual(164);
    expect(geometry.inputWidth).toBeGreaterThan(geometry.available - 40);
    expect(geometry.below).toBe(true); expect(geometry.overflow).toBe(false);
    await input.fill(Array.from({ length: 12 }, (_, i) => `입력 줄 ${i + 1}`).join("\n"));
    expect(await height()).toBe(120);
    await expect(page.getByRole("button", { name: "메시지 보내기", exact: true })).toBeInViewport();
    await input.fill(""); expect(await height()).toBe(44);
    await page.setViewportSize({ width, height: 520 });
    await expect(page.locator(".composer-area")).toHaveAttribute("data-compact", "true");
    expect(await page.locator(".composer-area").evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(116);
    await expect(page.locator(".workspace-navigation")).toHaveCount(0);
    await expect(page.getByTestId("product-switcher")).toBeVisible();
    await centeredHeader();
    await expect(page.getByRole("button", { name: "파일 첨부", exact: true })).toBeInViewport();
  });
}

test("empty workspaces and model controls preserve separate drafts without creating sample conversations", async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId("workspace-start")).toHaveAttribute("data-product", "chat");
  await expect(page.locator(".workspace-welcome article, .workspace-welcome button")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("");
  await page.getByRole("textbox").fill("My Chat draft");
  await page.locator(".model-trigger").click();
  await expect(page.getByRole("dialog", { name: "모델 선택", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByTestId("workspace-start")).toHaveAttribute("data-product", "review");
  await expect(page.getByRole("textbox")).toHaveValue("");
  await page.getByRole("textbox").fill("My Review draft");
  await page.locator(".review-setup-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("My Chat draft");
  await page.getByRole("navigation").getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("My Review draft");
  await expect(page.locator("article.user")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo") ?? "[]").length)).toBe(0);
});

test("Review loading stays inside product navigation without a floating loading paragraph", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const fixture = "const reviewWaiters=[];window.__releaseReviewLoad=()=>reviewWaiters.splice(0).forEach(resolve=>resolve());transport.listReview=async()=>{await new Promise(resolve=>reviewWaiters.push(resolve));return [];};";
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
  await signIn(page);
  const before = await page.locator(".composer-area").evaluate(node => node.getBoundingClientRect().height);
  await page.getByRole("navigation").getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator(".workspace-navigation .workspace-loading")).toBeVisible();
  await expect(page.locator(".review-workspace > p[role=status]")).toHaveCount(0);
  expect(await page.locator(".composer-area").evaluate(node => node.getBoundingClientRect().height)).toBe(before);
  await page.evaluate(() => (window as unknown as { __releaseReviewLoad: () => void }).__releaseReviewLoad());
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toBeEnabled();
});

test("copying an answer copies its text and reports clipboard failure without a send", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { __copiedAnswer: string }).__copiedAnswer = text; } } });
  });
  await signIn(page);
  await page.getByRole("textbox").fill("Copy this answer");
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  const answer = page.locator("article.assistant");
  await answer.getByRole("button", { name: "복사", exact: true }).click();
  await expect(answer.getByRole("button", { name: "복사됨", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __copiedAnswer: string }).__copiedAnswer)).toContain("Copy this answer");
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined }); });
  await answer.getByRole("button", { name: "복사됨", exact: true }).click();
  await expect(answer.getByRole("alert")).toHaveText("복사하지 못했습니다");
  await expect(page.locator("article.user")).toHaveCount(1);
});

test("a new Chat starts at the empty workspace instead of inheriting the previous answer scroll", async ({ page }) => {
  await signIn(page);
  await page.getByRole("textbox").fill("브랜드 소개 문구를 더 짧고 선명하게 다듬어 줘.");
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await expect(page.locator("article.assistant").getByRole("button", { name: "복사", exact: true })).toBeVisible();
  await page.locator(".header-new-chat").click();
  await expect(page.locator(".workspace-welcome h1")).toBeInViewport();
  expect(await page.locator(".transcript").evaluate(node => node.scrollTop)).toBe(0);
});
