import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * docs/policy/user-attachment-persistence.md section 5.1.
 *
 * A picture a signed-in person sent used to come back as a generic icon card
 * whenever the conversation was opened again, because only the sending tab
 * held a local preview. A saved raster image now asks the owner-only preview
 * route for its thumbnail; anything else keeps its icon, and a thumbnail that
 * fails to load falls back to that same icon card.
 */

const IMAGE_ATTACHMENT_ID = "att-sent-photo";
const PDF_ATTACHMENT_ID = "att-sent-pdf";

// A 2x2 red PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=",
  "base64"
);

const seedConversation = (page: Page) =>
  mockAuthenticatedApi(page, {
    selectedModels: ["gpt-5-4-mini"],
    messages: [
      {
        id: "msg-with-photo",
        role: "user",
        content: "이 두 파일을 PDF로 합쳐 주세요",
        attachments: [
          {
            id: IMAGE_ATTACHMENT_ID,
            attachmentId: IMAGE_ATTACHMENT_ID,
            ordinal: 0,
            name: "KakaoTalk_20261114.jpg",
            mediaType: "image/jpeg",
            size: 120_000,
            kind: "file",
          },
          {
            id: PDF_ATTACHMENT_ID,
            attachmentId: PDF_ATTACHMENT_ID,
            ordinal: 1,
            name: "탄원서.pdf",
            mediaType: "application/pdf",
            size: 80_000,
            kind: "file",
          },
        ],
      },
      {
        id: "msg-answer",
        role: "assistant",
        content: "확인했습니다.",
        modelId: "gpt-5-4-mini",
      },
    ],
  });

test.describe("a sent image in a reopened conversation", () => {
  test("shows its thumbnail, and a document keeps its icon", async ({ page }) => {
    const previewRequests: string[] = [];
    await prepareGuestPage(page, "ko");
    await seedConversation(page);
    await page.route("**/api/attachments/*/preview", async (route) => {
      previewRequests.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: PNG_BYTES,
      });
    });
    await page.goto("/review");
    await openRecentConversation(page);

    const thumbnail = page.getByTestId("chat-attachment-thumbnail");
    await expect(thumbnail).toHaveCount(1);
    await expect(thumbnail).toHaveAttribute("alt", "KakaoTalk_20261114.jpg");
    await expect
      .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);

    // Addressed by the opaque row id; nothing else is asked for.
    expect(new Set(previewRequests)).toEqual(
      new Set([`/api/attachments/${IMAGE_ATTACHMENT_ID}/preview`])
    );

    // The PDF has no thumbnail and stays an icon card with its name.
    await expect(
      page.getByTestId("chat-attachment-card").filter({ hasText: "탄원서.pdf" })
    ).toBeVisible();
  });

  test("falls back to the icon card when the thumbnail cannot be loaded", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await seedConversation(page);
    await page.route("**/api/attachments/*/preview", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Not found" }),
      })
    );
    await page.goto("/review");
    await openRecentConversation(page);

    const card = page
      .getByTestId("chat-attachment-card")
      .filter({ hasText: "KakaoTalk_20261114.jpg" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("JPG");
    await expect(page.getByTestId("chat-attachment-thumbnail")).toHaveCount(0);
  });
});
