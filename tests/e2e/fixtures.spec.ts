import { expect, test } from "@playwright/test";
import {
  createQaPdfBuffer,
  createQaPngBuffer,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

test("mock chat returns deterministic text", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "QA mock response");

  await page.goto("/chat");
  await page.getByTestId("chat-textarea").fill("QA message");
  await page.getByTestId("chat-textarea").press("Enter");

  await expect(page.getByText("QA message", { exact: true })).toBeVisible();
  await expect(page.getByText("QA mock response", { exact: true })).toBeVisible();
});

test("generated upload fixtures have valid signatures", () => {
  expect(createQaPngBuffer().subarray(0, 8).toString("hex")).toBe(
    "89504e470d0a1a0a"
  );
  expect(createQaPdfBuffer().subarray(0, 5).toString("ascii")).toBe("%PDF-");
});
