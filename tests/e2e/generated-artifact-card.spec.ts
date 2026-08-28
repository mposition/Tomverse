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

/* -------------------------------------------------------------------------- */
/* A file the answer began and never finished                                   */
/* -------------------------------------------------------------------------- */

/**
 * The reported turn, as the browser receives it.
 *
 * Claude Haiku 4.5 wrote a short preamble, began a `create_text_file` call for
 * an HTML page, and hit its output ceiling while it was still writing the
 * input. The server now records that as a `turn_incomplete` artifact
 * (lib/generatedArtifactTurnTracker.ts) rather than letting the answer end on
 * a promise with nothing after it.
 */
const TRUNCATED_ANSWER = "이 자료를 바탕으로 웹페이지를 만들겠습니다:";
const INCOMPLETE_ARTIFACT: ChatStreamArtifact = {
  id: "art_incomplete",
  ordinal: 0,
  // The fallback descriptor for the text kind: the model never finished naming
  // a format or a filename, and neither is read back off a partial input.
  format: "txt",
  filename: "generated.txt",
  mediaType: "text/plain",
  byteSize: 0,
  status: "failed",
  failureCode: "turn_incomplete",
  modelId: "claude-haiku-4-5",
};

const truncatedBody = (artifacts: ChatStreamArtifact[]) =>
  TRUNCATED_ANSWER +
  buildChatStreamTrailerChunk({
    searchMetadata: null,
    completion: { status: "incomplete", incompleteReason: "length" },
    ...(artifacts.length ? { artifacts } : {}),
  });

test("an answer cut off mid file says so on its own card @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, truncatedBody([INCOMPLETE_ARTIFACT]));
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "이 PPT를 웹페이지로 만들어줘");

  await expect(card(page)).toHaveAttribute("data-artifact-status", "failed");
  await expect(inCard(page, "generated-artifact-failure")).toHaveText(
    "파일이 완성되기 전에 답변이 끝났습니다."
  );
  // The turn is still an incomplete turn, and still says so. The card explains
  // the missing file; the notice explains the truncated answer. Scoped to the
  // first panel for the reason every locator here is: a guest conversation
  // renders three, and the mocked answer is served to all of them.
  await expect(
    page.getByTestId("response-incomplete-notice").first()
  ).toBeVisible();
  // And the preamble that promised the file is still shown, because it is what
  // the model actually said.
  await expect(page.getByTestId("chat-message").last()).toContainText(
    TRUNCATED_ANSWER
  );
});

test("the same truncation with no file begun draws no card at all", async ({
  page,
}, testInfo) => {
  // The ordinary long answer that ran out of room. Nothing was promised, so
  // nothing is owed: the generic notice on its own is the whole of it.
  await prepareGuestPage(page, "ko");
  await mockChat(page, truncatedBody([]));
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "아주 긴 설명을 써줘");

  await expect(
    page.getByTestId("response-incomplete-notice").first()
  ).toBeVisible();
  await expect(page.getByTestId("generated-artifact-section")).toHaveCount(0);
  await expect(page.getByTestId("generated-artifact-pending")).toHaveCount(0);
});

test("a signed-in account can retry the file the answer never finished @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: ["claude-haiku-4-5"] });
  // A brand-new account, so the conversation the send creates starts empty and
  // the panel resolves deterministically.
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  let chatRequests = 0;
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    chatRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": "qa-trace-incomplete" },
      body: truncatedBody([INCOMPLETE_ARTIFACT]),
    });
  });

  await page.goto("/chat?lang=ko");
  await sendChatMessage(page, testInfo, "이 PPT를 웹페이지로 만들어줘");

  await expect(card(page)).toHaveAttribute("data-artifact-status", "failed");
  const retry = inCard(page, "generated-artifact-retry");
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText("파일 다시 만들기");
  // The existing retry behaviour, unchanged: it re-sends the prompt, and it
  // does so only when the user asks.
  expect(chatRequests).toBe(1);
  await retry.click();
  await expect.poll(() => chatRequests).toBe(2);
});

test("the turn_incomplete card comes back after a reload @ui-risk", async ({
  page,
}) => {
  // The row went down in the assistant message's own transaction, so nothing
  // has to stream for the card to be here: this one comes from the
  // conversation endpoint.
  await mockAuthenticatedApi(page, {
    selectedModels: ["claude-haiku-4-5"],
    messages: [
      { id: "m-user", role: "user", content: "이 PPT를 웹페이지로 만들어줘" },
      {
        id: "m-assistant",
        role: "assistant",
        content: TRUNCATED_ANSWER,
        modelId: "claude-haiku-4-5",
        status: "incomplete",
        artifacts: [INCOMPLETE_ARTIFACT],
      },
    ],
  });
  await page.goto("/chat?lang=ko");
  await openRecentConversation(page);

  await expect(card(page)).toHaveAttribute("data-artifact-status", "failed");
  await expect(inCard(page, "generated-artifact-failure")).toHaveText(
    "파일이 완성되기 전에 답변이 끝났습니다."
  );

  await page.reload();
  await expect(card(page)).toHaveAttribute("data-artifact-status", "failed");
  await expect(inCard(page, "generated-artifact-failure")).toHaveText(
    "파일이 완성되기 전에 답변이 끝났습니다."
  );
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

/**
 * The width that actually decides the card's layout.
 *
 * A model panel inside a 1440px window is around 300px wide, so a card in it
 * has to stack -- and the 320px test above cannot ask that question, because
 * it shrinks the *window*. Constraining the artifact area alone, with the
 * window left wide, is the regression: with the layout keyed to `sm:` the row
 * variant applied here anyway and squeezed the text column to ~80px.
 */
const NARROW_PANEL_CSS = `
  [data-testid="generated-artifact-section"] {
    width: 320px !important;
    max-width: 320px !important;
  }
`;

test("a narrow panel in a wide window stacks the card @ui-risk", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "ko");
  await mockChat(
    page,
    answerWith([
      {
        ...ARTIFACT,
        filename: "2026년_분기별_매출_상세_집계_최종본_확정.xlsx",
      },
    ])
  );
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");
  await expect(card(page)).toBeVisible();
  await page.addStyleTag({ content: NARROW_PANEL_CSS });

  const box = (await card(page).boundingBox())!;
  const name = (await inCard(page, "generated-artifact-filename").boundingBox())!;
  const button = (await inCard(page, "generated-artifact-download").boundingBox())!;

  // The panel really is narrow while the window is not.
  expect(box.width).toBeLessThanOrEqual(322);
  expect(page.viewportSize()!.width).toBe(1440);

  // Separate rows, and the name keeps a column it can be read in.
  expect(button.y).toBeGreaterThanOrEqual(name.y + name.height - 1);
  expect(name.width).toBeGreaterThanOrEqual(200);
  // The stacked layout, not a row that merely wrapped: the control takes the
  // card's whole content width (320px less the 12px padding on each side).
  expect(button.width).toBeGreaterThanOrEqual(box.width - 26);

  // Nothing escapes the card on either side.
  for (const element of [name, button]) {
    expect(element.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(element.x + element.width).toBeLessThanOrEqual(box.x + box.width + 1);
  }
  expect(button.height).toBeGreaterThanOrEqual(44);
});

test("a failure in a narrow panel keeps a readable sentence and its own row @ui-risk", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAuthenticatedApi(page, {
    selectedModels: ["gpt-5-6-luna"],
    messages: [
      { id: "m-user", role: "user", content: "엑셀로 만들어줘" },
      {
        id: "m-assistant",
        role: "assistant",
        content: "파일을 만들지 못했습니다.",
        modelId: "gpt-5-6-luna",
        artifacts: [
          {
            ...ARTIFACT,
            id: "art_failed",
            byteSize: 0,
            status: "failed",
            failureCode: "generation_failed",
            modelId: "gpt-5-6-luna",
          },
        ],
      },
    ],
  });
  await page.goto("/chat?lang=ko");
  await openRecentConversation(page);
  await expect(card(page)).toBeVisible();
  await page.addStyleTag({ content: NARROW_PANEL_CSS });

  const box = (await card(page).boundingBox())!;
  const failure = (await inCard(page, "generated-artifact-failure").boundingBox())!;
  const retry = (await inCard(page, "generated-artifact-retry").boundingBox())!;

  // The description is a sentence, not a vertical ribbon of single characters.
  expect(failure.width).toBeGreaterThanOrEqual(200);
  expect(retry.y).toBeGreaterThanOrEqual(failure.y + failure.height - 1);
  expect(retry.width).toBeGreaterThanOrEqual(box.width - 26);
  expect(retry.x).toBeGreaterThanOrEqual(box.x - 1);
  expect(retry.x + retry.width).toBeLessThanOrEqual(box.x + box.width + 1);
  expect(retry.height).toBeGreaterThanOrEqual(44);
});

/* -------------------------------------------------------------------------- */
/* A failure the same turn fixed                                                */
/* -------------------------------------------------------------------------- */

/** One artifact for the recovery cases, named by the fields identity reads. */
const recoveryArtifact = (
  ordinal: number,
  status: "ready" | "failed",
  overrides: {
    filename?: string;
    /** The fixture's stored-conversation shape carries these two formats. */
    format?: "xlsx" | "csv";
    modelId?: string;
  } = {}
) => ({
  ...ARTIFACT,
  id: `art_${status}_${ordinal}`,
  ordinal,
  filename: "분기별_매출.xlsx",
  byteSize: status === "ready" ? 3053 : 0,
  status,
  ...(status === "failed" ? { failureCode: "spec_rejected" as const } : {}),
  modelId: "gpt-5-6-luna",
  ...overrides,
});

const firstSection = (page: Page) =>
  page.getByTestId("generated-artifact-section").first();

test("a failure the model fixed in the same turn leaves one card @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(
    page,
    answerWith([
      { ...recoveryArtifact(0, "failed"), modelId: "gemini-2-5-flash" },
      { ...recoveryArtifact(1, "ready"), modelId: "gemini-2-5-flash" },
    ])
  );
  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "분기별 매출을 엑셀로 만들어줘");

  const cards = firstSection(page).getByTestId("generated-artifact-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-artifact-status", "ready");
  // No apology, and no offer to redo work that already succeeded.
  await expect(firstSection(page).getByTestId("generated-artifact-failure")).toHaveCount(0);
  await expect(firstSection(page).getByTestId("generated-artifact-retry")).toHaveCount(0);
  await expect(
    firstSection(page).getByTestId("generated-artifact-download")
  ).toBeVisible();
});

test("the same turn shows the same one card after a reload @ui-risk", async ({
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
        artifacts: [recoveryArtifact(0, "failed"), recoveryArtifact(1, "ready")],
      },
    ],
  });
  await page.goto("/chat?lang=ko");
  await openRecentConversation(page);

  const cards = firstSection(page).getByTestId("generated-artifact-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-artifact-status", "ready");

  // The streamed answer and the stored one are the same set of rows, so they
  // have to reach the same cards.
  await page.reload();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-artifact-status", "ready");
});

test("a failure nothing fixed keeps its card and its retry @ui-risk", async ({
  page,
}) => {
  await mockAuthenticatedApi(page, {
    selectedModels: ["gpt-5-6-luna"],
    messages: [
      { id: "m-user", role: "user", content: "엑셀로 만들어줘" },
      {
        id: "m-assistant",
        role: "assistant",
        content: "파일을 만들지 못했습니다.",
        modelId: "gpt-5-6-luna",
        artifacts: [recoveryArtifact(0, "failed")],
      },
    ],
  });
  await page.goto("/chat?lang=ko");
  await openRecentConversation(page);

  const cards = firstSection(page).getByTestId("generated-artifact-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-artifact-status", "failed");
  await expect(
    firstSection(page).getByTestId("generated-artifact-retry")
  ).toBeVisible();
});

/**
 * The four turns the hiding rule must *not* fire on.
 *
 * One conversation, one panel, four answers -- each renders its own section,
 * so a single load asks all four questions.
 */
const KEPT_FAILURES = [
  {
    name: "another file's success",
    artifacts: [
      recoveryArtifact(0, "failed"),
      recoveryArtifact(1, "ready", { filename: "월별_매출.xlsx" }),
    ],
  },
  {
    name: "another format's success",
    artifacts: [
      recoveryArtifact(0, "failed"),
      recoveryArtifact(1, "ready", { format: "csv", filename: "분기별_매출.csv" }),
    ],
  },
  {
    name: "another model's success",
    artifacts: [
      recoveryArtifact(0, "failed"),
      recoveryArtifact(1, "ready", { modelId: "gemini-2-5-flash" }),
    ],
  },
  {
    name: "a failure that came after the success",
    artifacts: [recoveryArtifact(0, "ready"), recoveryArtifact(1, "failed")],
  },
];

test("only the same file, format and model resolves a failure @ui-risk", async ({
  page,
}) => {
  await mockAuthenticatedApi(page, {
    selectedModels: ["gpt-5-6-luna"],
    messages: KEPT_FAILURES.flatMap((turn, index) => [
      { id: `m-user-${index}`, role: "user" as const, content: `${index}번 요청` },
      {
        id: `m-assistant-${index}`,
        role: "assistant" as const,
        content: `${index}번 답변`,
        modelId: "gpt-5-6-luna",
        artifacts: turn.artifacts,
      },
    ]),
  });
  await page.goto("/chat?lang=ko");
  await openRecentConversation(page);

  const sections = page.getByTestId("generated-artifact-section");
  await expect(sections).toHaveCount(KEPT_FAILURES.length);
  for (const [index, turn] of KEPT_FAILURES.entries()) {
    const cards = sections.nth(index).getByTestId("generated-artifact-card");
    await expect(cards, turn.name).toHaveCount(2);
    await expect(
      sections.nth(index).getByTestId("generated-artifact-failure"),
      turn.name
    ).toBeVisible();
  }
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

/* ------------------------------------------------------------------------ */
/* The SVG preview                                                           */
/* ------------------------------------------------------------------------ */

const SVG_ARTIFACT = {
  id: "art_infographic",
  ordinal: 0,
  format: "svg" as const,
  filename: "hypertension_healthy_foods.svg",
  mediaType: "image/svg+xml; charset=utf-8",
  byteSize: 214,
  status: "ready" as const,
  modelId: "gemini-2-5-flash",
};

const SVG_BODY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">' +
  '<rect width="120" height="60" fill="#e94b35"/>' +
  '<text x="60" y="35" text-anchor="middle" fill="#ffffff">food</text>' +
  "</svg>";

const serveSvg = async (page: Page, requested: string[]) => {
  await page.route("**/api/artifacts/**", async (route: Route) => {
    requested.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": 'attachment; filename="generated.svg"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
      body: SVG_BODY,
    });
  });
};

test("an SVG is shown in the card, not only offered as a download @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([SVG_ARTIFACT], "인포그래픽을 만들었습니다."));
  const requested: string[] = [];
  await serveSvg(page, requested);

  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "인포그래픽으로 그려줘");
  await expect(card(page)).toBeVisible();

  // Scoped to one card: a guest conversation renders three model panels, so a
  // page-level lookup matches the same preview once per panel.
  const preview = inCard(page, "generated-artifact-preview");
  await expect(preview).toBeVisible();
  // Fetched through the app's own route, like the download.
  expect(requested).toContain("/api/artifacts/art_infographic");
  // Actually decoded by the browser rather than merely present in the DOM.
  await expect
    .poll(() => preview.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  // The download stays: a preview is an addition, not a replacement.
  await expect(inCard(page, "generated-artifact-download")).toBeVisible();
});

test("the preview is an img element, so the SVG cannot run in this origin", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([SVG_ARTIFACT], "인포그래픽을 만들었습니다."));
  await serveSvg(page, []);

  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "인포그래픽으로 그려줘");
  const preview = inCard(page, "generated-artifact-preview");
  await expect(preview).toBeVisible();

  // An img puts the SVG in the browser's secure static mode. An inlined
  // <svg>, an <object> or an <iframe> would each give that up, so the tag name
  // is the contract rather than an implementation detail.
  expect(await preview.evaluate((node) => node.tagName)).toBe("IMG");
  // A blob URL: the markup never enters this document.
  expect(await preview.getAttribute("src")).toMatch(/^blob:/);
  // The card's own SVG markup is not in the page.
  expect(await page.content()).not.toContain("text-anchor=");
});

test("a preview that fails to load leaves the card working", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([SVG_ARTIFACT], "인포그래픽을 만들었습니다."));
  await page.route("**/api/artifacts/**", async (route: Route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "nope" }),
    });
  });

  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "인포그래픽으로 그려줘");
  await expect(card(page)).toBeVisible();

  // Silent: no preview, no second error row, and the control still there.
  await expect(page.getByTestId("generated-artifact-preview")).toHaveCount(0);
  await expect(page.getByTestId("generated-artifact-download-error")).toHaveCount(0);
  await expect(inCard(page, "generated-artifact-download")).toBeVisible();
});

test("a non-image format gets no preview", async ({ page }, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(page, answerWith([ARTIFACT]));
  const requested: string[] = [];
  await page.route("**/api/artifacts/**", async (route: Route) => {
    requested.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": XLSX_MEDIA_TYPE },
      body: Buffer.from("PKfake"),
    });
  });

  await page.goto("/chat");
  await sendChatMessage(page, testInfo, "엑셀로 만들어줘");
  await expect(card(page)).toBeVisible();

  await expect(page.getByTestId("generated-artifact-preview")).toHaveCount(0);
  // And nothing was fetched for it: a spreadsheet is not downloaded twice.
  expect(requested).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* Web search and a file in the same turn                                       */
/* -------------------------------------------------------------------------- */

/**
 * A search and a file in one answer, on a Google model.
 *
 * This combination used to be impossible, and for a reason that was true when
 * it was written: Google's Search grounding is a built-in retrieval tool and
 * cannot ride on a request that also carries function declarations, so
 * `planGeneratedArtifactTool` refused the artifact tools for every searching
 * Google turn (`native_search_conflict`). A user who asked to "look this up and
 * put it in a spreadsheet" got one or the other.
 *
 * The Google models no longer search through grounding. Their `web_search` is a
 * function declaration this application executes, so there is no built-in tool
 * on the request for the `create_*` tools to be exclusive with, and both may be
 * registered. What that looks like from here is one answer carrying a source
 * list and a download card.
 */
test("a Google turn can search and produce a file in the same answer @ui-risk", async ({
  page,
}, testInfo) => {
  await prepareGuestPage(page, "ko");
  await mockChat(
    page,
    `${buildArtifactProgressChunk("xlsx")}검색해서 표로 정리했습니다.` +
      buildChatStreamTrailerChunk({
        searchMetadata: {
          requested: true,
          supported: true,
          executed: true,
          provider: "google",
          executionKind: "app_managed",
          searchBackend: "brave",
          tool: "web_search",
          queryCount: 2,
          backendRequestCount: 2,
          citations: [
            { url: "https://example.com/model-a", title: "Model A" },
            { url: "https://example.com/model-b", title: "Model B" },
          ],
        },
        completion: { status: "normal" },
        artifacts: [ARTIFACT],
      })
  );
  await page.goto("/chat");

  await sendChatMessage(page, testInfo, "최신 모델 정보를 검색해서 xlsx로 만들어줘");

  // Both, in one message. Either one alone would be the old behaviour.
  await expect(card(page)).toBeVisible();
  await expect(inCard(page, "generated-artifact-filename")).toHaveText(
    ARTIFACT.filename
  );
  const citations = page
    .getByTestId("search-citation-list")
    .first()
    .getByRole("link");
  await expect(citations).toHaveCount(2);
  await expect(citations.first()).toHaveAttribute(
    "href",
    "https://example.com/model-a"
  );
  // And the answer is still a sentence rather than the table it wrote to the
  // file -- the rule the artifact tools exist to enforce does not relax
  // because a search also ran.
  await expect(page.getByTestId("chat-message-list").first()).not.toContainText(
    "```"
  );
});
