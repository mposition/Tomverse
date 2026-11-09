import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test("Korean FAQ links to current guest limits without rewriting Chat to Review", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.includes("mobile") ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "ko");
  await page.goto("/faq?lang=ko");
  const existingEntry = page.getByTestId("marketing-header-app-cta");
  await expect(existingEntry).toHaveAttribute("data-session-state", "unauthenticated");
  const guestChatAvailable = new URL((await existingEntry.getAttribute("href"))!, page.url()).pathname === "/chat";
  const entries = page.getByTestId("faq-guest-trial-links");
  await expect(entries).toBeVisible();
  await expect(entries).toContainText(guestChatAvailable ? "현재 비회원 Chat 체험: 제공 중" : "현재 비회원 Chat 체험: 제공하지 않음");
  const chat = entries.getByRole("link", { name: "Chat에서 현재 비회원 모델·사용량 확인" });
  if (guestChatAvailable) await expect(chat).toHaveAttribute("href", "/chat?lang=ko");
  else await expect(chat).toHaveCount(0);
  await expect(entries.getByRole("link", { name: "Review에서 현재 비회원 모델·사용량 확인" })).toHaveAttribute("href", "/review?lang=ko");
  await expect(entries.getByRole("link", { name: "모델별 이용 시작 플랜 확인" })).toHaveAttribute("href", "/ko/models");
  if (guestChatAvailable) {
    await chat.click();
    await expect(page).toHaveURL(/\/chat\?lang=ko$/);
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
  }
});
