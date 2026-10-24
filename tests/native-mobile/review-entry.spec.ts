import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { workspaceWelcomeCopy } from "../../locales/workspaceWelcome";

const storage = "tomverse-native-synthetic-demo";
const output = resolve(process.cwd(), "../../.tmp/native-parity");
test.beforeEach(async ({ page }) => {
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.addInitScript(key => {
    localStorage.setItem("tomverse-language", "ko"); localStorage.setItem("tomverse-theme", "light");
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([
      { id: "saved-review", title: "Saved comparison", surface: "workspace", selectedModels: ["demo", "demo-b"], messages: [{ id: "review-question", role: "user", content: "Previous Review question" }, { id: "review-answer", role: "assistant", modelId: "demo", content: "Previous answer", status: "normal" }] },
      { id: "saved-chat", title: "Saved Chat", selectedModels: ["demo"], messages: [{ id: "chat-question", role: "user", content: "Previous Chat question" }] },
    ]));
    localStorage.setItem("tomverse-native-last-review:synthetic-demo", "saved-review");
  }, storage);
});
async function signIn(page: Page) {
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
}
async function reviewHome(page: Page) {
  await page.getByTestId("product-switcher").selectOption("review");
  await expect(page.getByRole("button", { name: /참여 모델 선택 · Easy/ })).toBeEnabled();
  await expect(page.getByTestId("review-landing")).toBeVisible();
}

test("Review entry stays on its landing page; only a history selection restores a saved comparison", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "대화", exact: true }).click(); await page.getByRole("button", { name: "Saved Chat", exact: true }).click();
  await expect(page.locator("article.user")).toContainText("Previous Chat question");
  await reviewHome(page);
  await expect(page.locator("article.user")).toHaveCount(0);
  await page.screenshot({ path: resolve(output, "review-landing-implemented-light.png") });
  await page.getByRole("button", { name: "같은 자료, 다른 해석.", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue(workspaceWelcomeCopy.ko.starter.cards.documentQuestions.seed);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).length, storage)).toBe(2);
  await page.getByRole("button", { name: "대화", exact: true }).click();
  await page.getByRole("button", { name: "Saved comparison", exact: true }).click();
  await expect(page.locator("article.user")).toContainText("Previous Review question");
  await page.getByTestId("product-switcher").selectOption("chat");
  await expect(page.locator(".chat-welcome")).toBeVisible(); await expect(page.locator("article.user")).toHaveCount(0);
  await reviewHome(page);
  await expect(page.locator("article.user")).toHaveCount(0);
  await page.reload(); await reviewHome(page);
  await expect(page.locator("article.user")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue(workspaceWelcomeCopy.ko.starter.cards.documentQuestions.seed);
});

test("Chat and Review share the same full-page history heading, action and search spacing", async ({ page }) => {
  await signIn(page); await page.getByRole("button", { name: "대화", exact: true }).click();
  const geometry = () => page.locator(".conversation-list").evaluate(node => {
    const heading = node.querySelector(".list-heading")!.getBoundingClientRect();
    const search = node.querySelector(".history-controls")!.getBoundingClientRect();
    return { top: heading.top, gap: search.top - heading.bottom, left: search.left, width: search.width };
  });
  await expect(page.getByRole("heading", { name: "대화", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "새 대화", exact: true }).filter({ hasText: "새 대화" })).toBeVisible();
  const chatGeometry = await geometry();
  await page.screenshot({ path: resolve(output, "chat-history-matched-light.png") });
  await reviewHome(page); await page.getByRole("button", { name: "대화", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대화", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "새 Review", exact: true })).toBeVisible();
  expect(await geometry()).toEqual(chatGeometry);
  await expect(page.locator(".sidebar-account")).toContainText("Demo User");
  await expect(page.getByRole("button", { name: "설정", exact: true })).toBeInViewport();
  await page.screenshot({ path: resolve(output, "review-history-matched-light.png") });
  await page.getByRole("button", { name: "새 Review", exact: true }).click();
  await expect(page.getByTestId("review-landing")).toBeVisible();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).length, storage)).toBe(2);
});

test("Review landing scrolls above a compact composer on a narrow, keyboard-sized screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 460 });
  await signIn(page); await reviewHome(page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.addStyleTag({ content: ".review-intro h1{font-size:36px}.review-intro p,.welcome-card strong{font-size:18px}" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await expect(page.getByRole("textbox")).toBeInViewport();
  await expect(page.getByRole("button", { name: /참여 모델 선택 · Easy/ })).toBeInViewport();
  await page.getByRole("button", { name: "코드 · 오류 해결", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue(workspaceWelcomeCopy.ko.starter.cards.debugStackTrace.seed);
});
