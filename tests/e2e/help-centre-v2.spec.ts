import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

// Help Centre v2: the hub (question box, common tasks, every category), the
// step-through guide page, and the assistant's answer card. The assistant's
// API is mocked here; its prompt, citation check and switch are unit-tested in
// tests/helpAssistantCore.test.mjs.

async function mockAssistant(page: Page, answer: unknown, availability = { enabled: true, signedIn: true }) {
  await page.route("**/api/help/assistant", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: availability });
    return route.fulfill({ json: { answer } });
  });
  await page.route("**/api/help/feedback", (route) => route.fulfill({ json: { ok: true } }));
}

test("the hub lists common tasks and every category, and search narrows to guides", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockAssistant(page, null, { enabled: false, signedIn: false });
  await page.goto("/en/support/help-centre");
  const hub = page.getByTestId("help-centre-hub");
  await expect(hub).toBeVisible({ timeout: 30_000 });
  await expect(hub.getByTestId("help-common-task")).toHaveCount(6);
  await expect(hub.getByTestId("help-category")).toHaveCount(15);
  await page.getByRole("textbox").first().fill("refund");
  const results = page.getByTestId("help-search-results");
  await expect(results.getByRole("link").first()).toHaveAttribute("href", /\/support\/help-centre\/guides\/request-refund\?lang=en/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a guide page steps through and keeps the step in the address", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockAssistant(page, null, { enabled: false, signedIn: false });
  await page.goto("/support/help-centre/guides/delete-account?lang=en");
  const guide = page.getByTestId("help-guide");
  await expect(guide.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  const steps = guide.getByTestId("help-guide-steps").getByRole("button");
  await expect(steps).toHaveCount(5);
  await guide.getByRole("button", { name: /next/i }).click();
  await expect(page).toHaveURL(/#step-2$/);
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await page.goto("/support/help-centre/guides/delete-account?lang=en#step-4");
  await expect(steps.nth(3)).toHaveAttribute("aria-current", "step");
  expect((await page.request.get("/support/help-centre/guides/not-a-guide?lang=en")).status()).toBe(404);
});

test("the attachment guide lists the supported formats once, from the format table", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockAssistant(page, null, { enabled: false, signedIn: false });
  await page.goto("/support/help-centre/guides/attach-files?lang=en");
  const list = page.getByTestId("help-attachment-formats");
  await expect(list).toBeVisible({ timeout: 30_000 });
  const copy = await list.innerText();
  for (const extension of ["png", "pdf", "docx", "hwp", "zip", "json"]) expect(copy).toContain(`.${extension}`);
  expect(copy.match(/\.pdf\b/g)).toHaveLength(1);
  await expect(list).toContainText("Without signing in: 1 file per message, up to 5 MB.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the assistant answer shows cited steps and links to the guide", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockAssistant(page, {
    status: "answered",
    summary: "Open the Plan tab to see your credits.",
    steps: [{ text: "Open the account menu.", guideId: "check-credits", step: 1 }],
    note: null,
    guideIds: ["check-credits"],
  });
  await page.goto("/en/support/help-centre");
  const box = page.getByTestId("help-ask-form");
  await box.getByRole("textbox").fill("Where are my credits?");
  await box.getByRole("button").click();
  const answer = page.getByTestId("help-answer");
  await expect(answer).toContainText("Open the Plan tab to see your credits.");
  await expect(answer.getByRole("link", { name: "[1]", exact: true })).toHaveAttribute("href", "/support/help-centre/guides/check-credits?lang=en#step-1");
  await answer.getByRole("button", { name: "👍" }).click();
  await expect(answer.getByRole("status")).toBeVisible();
});

test("an answer the guides do not cover offers support instead of a guess", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockAssistant(page, { status: "not_found", summary: "문서에서 찾지 못했습니다." });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ko/support/help-centre");
  const box = page.getByTestId("help-ask-form");
  await box.getByRole("textbox").fill("메모장 기능이 있나요?");
  await box.getByRole("button").click();
  const answer = page.getByTestId("help-answer-not-found");
  await expect(answer).toContainText("문서에서 찾지 못했습니다.");
  await expect(answer.getByRole("link")).toHaveAttribute("href", "/ko/support");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
