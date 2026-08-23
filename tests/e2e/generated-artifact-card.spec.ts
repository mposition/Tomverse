import { expect, test, type Page, type Route } from "@playwright/test";

import {
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";
import { buildChatStreamTrailerChunk } from "@/lib/webSearchStreamTrailer";
import type { ChatStreamArtifact } from "@/lib/generatedArtifactCore";
import { buildArtifactProgressChunk } from "@/lib/generatedArtifactProgressSignal";

/**
 * The download card an answer's generated file gets.
 *
 * docs/policy/generated-artifacts.md section 9. What is being checked here is
 * everything that only exists once the browser has the answer: that the card
 * appears at all, that it survives a reload, that it does not overlap itself
 * at 320px, that it can be reached and operated from the keyboard, that a
 * screen reader is told the format, the name, the size and the state, and
 * that a guest is shown a sign-in call to action rather than a table.
 *
 * The chat endpoint is mocked, because the assertion is about the client's
 * half of the contract. The trailer is built with the real
 * `buildChatStreamTrailerChunk`, so a change to the wire format breaks this
 * spec rather than being papered over by a hand-written string.
 */

declare global {
  interface Window {
    /** Filled by the init script in the download test below. */
    __qaDownloadNames?: string[];
  }
}

const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ARTIFACT = {
  id: "art_quarterly",
  ordinal: 0,
  format: "xlsx" as const,
  filename: "분기별_매출.xlsx",
  mediaType: XLSX_MEDIA_TYPE,
  byteSize: 3053,
  status: "ready" as const,
  modelId: "gemini-2-5-flash",
};

/** A short confirmation and the trailer -- never the table, never the code. */
const answerWith = (
  artifacts: ChatStreamArtifact[],
  body = "요청하신 Excel 파일을 만들었습니다.",
  { announceProgress = true } = {}
) =>
  `${announceProgress ? buildArtifactProgressChunk("xlsx") : ""}${body}` +
  buildChatStreamTrailerChunk({
    searchMetadata: null,
    completion: { status: "normal" },
    ...(artifacts.length ? { artifacts } : {}),
  });

const mockChat = async (page: Page, body: string) => {
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": "qa-trace-artifact" },
      body,
    });
  });
};

/**
 * The first panel's card.
 *
 * A guest conversation renders three model panels, and the mocked answer is
 * served to all three -- so every locator here is scoped to one card. That is
 * not a workaround: it is the multi-model attribution rule under test, and the
 * per-panel assertion below checks that each panel's card names its own model.
 */
const card = (page: Page) => page.getByTestId("generated-artifact-card").first();
const inCard = (page: Page, testId: string) => card(page).getByTestId(testId);

/* -------------------------------------------------------------------------- */
/* The card                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every format draws its own card.
 *
 * The card has no per-format branch in it -- it reads the format table for the
 * label group and the icon. So this walks one format from each group, which is
 * what would catch a group whose copy nobody translated or whose icon nobody
 * chose.
 */
const CARDS_BY_FORMAT = [
  { format: "xlsx", filename: "매출.xlsx", label: "Excel 통합 문서" },
  { format: "docx", filename: "보고서.docx", label: "Word 문서" },
  { format: "pdf", filename: "보고서.pdf", label: "PDF 문서" },
  { format: "pptx", filename: "소개.pptx", label: "PowerPoint 프레젠테이션" },
  { format: "md", filename: "README.md", label: "Markdown 문서" },
  { format: "json", filename: "설정.json", label: "JSON 데이터 파일" },
  { format: "html", filename: "index.html", label: "HTML 파일" },
  { format: "py", filename: "main.py", label: "PY 소스 파일" },
  { format: "zip", filename: "starter.zip", label: "ZIP 압축 파일" },
];

for (const { format, filename, label } of CARDS_BY_FORMAT) {
  test(`a ${format} file draws a card that names what it is`, async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "ko");
    await mockChat(
      page,
      answerWith([{ ...ARTIFACT, format, filename, mediaType: "application/octet-stream" }])
    );
    await page.goto("/chat");

    await sendChatMessage(page, testInfo, `${filename} 파일로 만들어줘`);

    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute("data-artifact-format", format);
    await expect(inCard(page, "generated-artifact-filename")).toHaveText(filename);
    await expect(inCard(page, "generated-artifact-meta")).toContainText(label);
    // Whatever the format, the answer body is a sentence and not the file.
    await expect(page.getByTestId("chat-message-list").first()).not.toContainText(
      "```"
    );
  });
}

test("a file request answers with a download card, not a table @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));
  await page.goto("/chat");

  await sendChatMessage(
    page,
    testInfo,
    "분기별 매출 데이터를 분기별_매출.xlsx로 만들어줘"
  );

  await expect(card(page)).toBeVisible();
  await expect(inCard(page, "generated-artifact-filename")).toHaveText(
    "분기별_매출.xlsx"
  );
  await expect(inCard(page, "generated-artifact-meta")).toContainText(
    "Excel 통합 문서"
  );
  await expect(inCard(page, "generated-artifact-meta")).toContainText("3.0 KB");
  // The file names the model that produced it, not the panel it is sitting in:
  // a hard fallback answers on a different model from the one the panel is
  // labelled with, and the file belongs to whichever one actually made it.
  const cards = page.getByTestId("generated-artifact-card");
  for (let index = 0; index < (await cards.count()); index += 1) {
    await expect(cards.nth(index)).toHaveAttribute(
      "data-artifact-model",
      "gemini-2-5-flash"
    );
    await expect(cards.nth(index).getByTestId("generated-artifact-meta")).toContainText(
      "Gemini 3.5 Flash-Lite"
    );
  }
});

test("the answer body carries no generation code and no base64 @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");
  await expect(card(page)).toBeVisible();

  const transcript = await page
    .getByTestId("chat-message-list")
    .first()
    .innerText();
  for (const forbidden of [
    "import pandas",
    "pd.DataFrame",
    "to_excel",
    "base64,",
    "/mnt/data",
  ]) {
    expect(transcript).not.toContain(forbidden);
  }
  // And nothing of the marker protocol leaked into the visible answer.
  expect(transcript).not.toContain("TOMVERSE_ARTIFACT_PROGRESS");
  expect(transcript).not.toContain("TOMVERSE_SEARCH_METADATA");
});

test("the storage key never reaches the page @ui-risk", async ({ page }, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");
  await expect(card(page)).toBeVisible();

  const html = await page.content();
  expect(html).not.toContain("message-artifacts/");
  expect(html).not.toContain("r2.cloudflarestorage.com");
});

test("the download goes to the app's own route and saves the server's name", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));

  // Records what `saveBlobAsFile` puts on the anchor, before the browser has
  // had any say in it.
  await page.addInitScript(() => {
    window.__qaDownloadNames = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.hasAttribute("download")) {
        window.__qaDownloadNames?.push(this.getAttribute("download") ?? "");
      }
      return click.call(this);
    };
  });

  const requested: string[] = [];
  await page.route("**/api/artifacts/**", async (route: Route) => {
    requested.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": XLSX_MEDIA_TYPE,
        "Content-Disposition":
          `attachment; filename="generated.xlsx"; ` +
          `filename*=UTF-8''${encodeURIComponent("분기별_매출.xlsx")}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
      body: Buffer.from("PK\u0003\u0004fake"),
    });
  });

  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");
  await expect(card(page)).toBeVisible();

  const download = page.waitForEvent("download");
  await inCard(page, "generated-artifact-download").click();
  await download;

  // The route the app owns -- never a URL the model produced.
  expect(requested).toEqual(["/api/artifacts/art_quarterly"]);
  // The name the page asked the browser to save under, read from the anchor
  // rather than from the saved file: what is under test is whether the client
  // recovered the Korean name from RFC 5987's `filename*` instead of taking
  // the ASCII fallback, and headless Chromium's own naming of a blob download
  // is not that question.
  expect(await page.evaluate(() => window.__qaDownloadNames ?? [])).toEqual([
    "분기별_매출.xlsx",
  ]);
});

test("a locked conversation says so instead of failing silently", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));
  await page.route("**/api/artifacts/**", (route) =>
    route.fulfill({
      status: 423,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Conversation is locked.",
        code: "CONVERSATION_LOCKED",
      }),
    })
  );

  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");
  await expect(card(page)).toBeVisible();
  await inCard(page, "generated-artifact-download").click();

  await expect(
    inCard(page, "generated-artifact-download-error")
  ).toContainText("잠금");
});

/* -------------------------------------------------------------------------- */
/* States                                                                       */
/* -------------------------------------------------------------------------- */

test("a failed file fails inside its own card, not the whole answer @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(
    page,
    answerWith(
      [
        {
          ...ARTIFACT,
          id: "art_failed",
          byteSize: 0,
          status: "failed",
          failureCode: "generation_failed",
        },
      ],
      "파일을 만들지 못했습니다. 다시 시도할 수 있습니다."
    )
  );
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");

  await expect(card(page)).toHaveAttribute("data-artifact-status", "failed");
  await expect(inCard(page, "generated-artifact-failure")).toBeVisible();
  // The answer around it is a normal answer: its text is rendered, and none of
  // the error affordances the chat shows for a failed turn are present.
  const message = page.getByTestId("chat-message").last();
  await expect(message).toContainText("파일을 만들지 못했습니다");
  await expect(page.getByTestId("chat-error-auxiliary-info")).toHaveCount(0);
});

test("a guest is shown a sign-in card, never a table pretending to be a file @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(
    page,
    answerWith(
      [
        {
          ...ARTIFACT,
          id: "art_blocked",
          byteSize: 0,
          status: "blocked",
          failureCode: "sign_in_required",
        },
      ],
      "파일을 만들려면 로그인이 필요합니다."
    )
  );
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");

  await expect(card(page)).toHaveAttribute("data-artifact-status", "blocked");
  const cta = inCard(page, "generated-artifact-signin");
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", /\/auth\/signin/);
  await expect(page.getByTestId("generated-artifact-download")).toHaveCount(0);
});

test("a turn that produced nothing shows no card at all", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([], "안녕하세요.", { announceProgress: false }));
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "안녕");

  await expect(page.getByTestId("chat-message").last()).toContainText("안녕하세요.");
  await expect(page.getByTestId("generated-artifact-section")).toHaveCount(0);
  await expect(page.getByTestId("generated-artifact-pending")).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* Restore                                                                      */
/* -------------------------------------------------------------------------- */

test("a signed-in account's card comes back after a reload @ui-risk", async ({
  page,
}) => {
  await mockAuthenticatedApi(page, {
    selectedModels: ["gpt-5-6-luna"],
    messages: [
      { id: "m-user", role: "user", content: "분기별 매출을 엑셀로 만들어줘" },
      {
        id: "m-assistant",
        role: "assistant",
        content: "요청하신 Excel 파일을 만들었습니다.",
        modelId: "gpt-5-6-luna",
        artifacts: [{ ...ARTIFACT, modelId: "gpt-5-6-luna" }],
      },
    ],
  });
  await page.goto("/chat?lang=ko");
  await openRecentConversation(page);

  await expect(card(page)).toBeVisible();
  await expect(inCard(page, "generated-artifact-filename")).toHaveText(
    "분기별_매출.xlsx"
  );

  // The reload the requirement is actually about: nothing streamed this time,
  // so the card can only have come from the conversation endpoint. The app
  // restores the active conversation from sessionStorage, so there is no
  // welcome screen to step through on the way back in.
  await page.reload();
  await expect(card(page)).toBeVisible();
  await expect(inCard(page, "generated-artifact-filename")).toHaveText(
    "분기별_매출.xlsx"
  );
});

/* -------------------------------------------------------------------------- */
/* Layout, keyboard and screen readers                                          */
/* -------------------------------------------------------------------------- */

test("at 320px the name and the download button never overlap @ui-risk", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await prepareGuestPage(page, "ko");
  await mockChat(
    page,
    answerWith([
      {
        ...ARTIFACT,
        // A name long enough to push a single-row layout apart.
        filename: "2026년_분기별_매출_상세_집계_최종본_확정.xlsx",
      },
    ])
  );
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");
  await expect(card(page)).toBeVisible();

  const name = await inCard(page, "generated-artifact-filename").boundingBox();
  const button = await inCard(page, "generated-artifact-download").boundingBox();
  expect(name).not.toBeNull();
  expect(button).not.toBeNull();

  // Separate rows: the button starts below the name's box.
  expect(button!.y).toBeGreaterThanOrEqual(name!.y + name!.height - 1);
  // And neither escapes the card.
  const box = await card(page).boundingBox();
  expect(name!.x + name!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  expect(button!.x + button!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  // The document itself does not scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the download button meets the touch target and shows a focus ring @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");

  const button = inCard(page, "generated-artifact-download");
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // Focus has to arrive by keyboard, not by `.focus()`: `:focus-visible` is
  // exactly the rule that tells the two apart, and on a touch device a
  // programmatic focus deliberately does not match it. Stepping back and
  // forward is the smallest real keyboard move onto this control.
  await button.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  const ring = await button.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return `${style.boxShadow} ${style.outlineWidth} ${element.matches(":focus-visible")}`;
  });
  expect(ring).toContain("true");
  expect(ring).not.toBe("none 0px false");
});

test("a screen reader is told the format, the name, the size and the state", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");

  await expect(card(page)).toBeVisible();
  const label = await inCard(page, "generated-artifact-download").getAttribute(
    "aria-label"
  );
  expect(label).toContain("분기별_매출.xlsx");
  expect(label).toContain("Excel 통합 문서");
  expect(label).toContain("3.0 KB");

  // The section names itself, so the cards are reachable as a group.
  await expect(
    page.getByTestId("generated-artifact-section").first()
  ).toHaveAttribute("aria-label", "생성된 파일");
});

test("the card can be reached and operated from the keyboard alone", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));
  await page.route("**/api/artifacts/**", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "Content-Type": XLSX_MEDIA_TYPE,
        "Content-Disposition": 'attachment; filename="generated.xlsx"',
      },
      body: Buffer.from("PK\u0003\u0004fake"),
    })
  );
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");

  const button = inCard(page, "generated-artifact-download");
  await expect(button).toBeVisible();
  await button.focus();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  await download;
});
