import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

test("Korean support guidance describes an inquiry and retains the actual threshold", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  let submitted = false;
  await page.route("**/api/feedback", (route) => { submitted = true; return route.abort(); });
  await page.goto("/support?lang=ko");
  const hint = page.getByTestId("support-message-hint");
  await expect(hint).toContainText("문의 내용을 5자 이상 입력해 주세요.");
  await expect(hint).not.toContainText("피드백");
  await page.getByLabel("이메일 주소", { exact: true }).fill("reporter@example.com");
  const message = page.getByRole("textbox", { name: /무슨 일이 있었고 어떤 결과를 기대했는지 알려주세요/ });
  await message.fill("abcd");
  await expect(page.getByTestId("support-submit")).toBeDisabled();
  await message.fill("abcde");
  await expect(page.getByTestId("support-submit")).toBeEnabled();
  await expect(hint).toContainText("문의 내용을 5자 이상 입력해 주세요.");
  expect(submitted).toBe(false);
});
