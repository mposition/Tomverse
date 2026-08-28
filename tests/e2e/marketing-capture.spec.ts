import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { prepareGuestPage } from "./support/app-fixtures";
import {
  enterConversation,
  expectThemeApplied,
  freezeAnimations,
  mockAuthenticatedApi,
  setDeterministicTheme,
  submitComposer,
  suppressTransientUi,
  type Theme,
} from "./support/chat-state-fixtures";
import {
  mockConversationHistory,
  openReviewConversation,
  reviewModels,
} from "./support/comparison-review-fixtures";

/**
 * Regenerates the two product screenshots the landing page uses as evidence.
 *
 * This is a generator, not an assertion suite. It is committed because the
 * alternative is what the 2026-07-30 audit found: a walkthrough recording made
 * once by hand, showing "4 credits used" (a figure corrected two days later)
 * and "Review confidence" (a label since renamed to source grounding), with no
 * procedure for anyone to redo it. A capture nobody knows how to regenerate is
 * a capture that goes stale and stays stale.
 *
 *   npx playwright test --project=desktop-chromium tests/e2e/marketing-capture.spec.ts
 *
 * Three rules make the output safe to publish:
 *
 * 1. **No customer data.** Every answer below is written here, in this file,
 *    and served by the same in-page stub the visual-regression goldens use.
 *    No provider is called, no credit is spent, no database is read.
 *
 * 2. **No server-derived number is ever inside the frame.** The review capture
 *    is clipped to start *below* the badge row, because that row carries
 *    `ai-review-used-credits` -- literally the "N credits used" string the
 *    retired recording was killed for. Prices, credit costs and grounding
 *    percentages are server-side values that change without anyone reopening
 *    an image editor, so they belong in live HTML on the page, never in a PNG.
 *    Cropping is how that is achieved: nothing in the product is hidden or
 *    restyled for the camera.
 *
 * 3. **Every model shown is guarded.** The trio is `reviewModels`, and all
 *    three ids are registered in `lib/marketingModelReferences.ts`, so
 *    `tests/marketingModelReferences.test.mjs` fails the build the moment one
 *    of them stops being publicly selectable. That is the check that turns
 *    "remember to re-shoot the marketing images" into a red build.
 */

const OUT = "public/marketing";

const THEMES: Theme[] = ["light", "dark"];
const CROPS = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
] as const;
const LOCALES = ["en", "ko"] as const;

/**
 * The review entry and run controls are named, not test-id'd, so the labels
 * are locale-dependent. Quoted from locales/{en,ko}.ts (`chat.aiReviewTitle`
 * and `chat.aiReviewRun`) rather than guessed: if either string is retranslated
 * this generator fails loudly instead of capturing the wrong screen.
 */
const REVIEW_LABELS = {
  en: { title: "AI answer cross-review", run: "Run cross-review" },
  ko: { title: "AI 답변 교차검토", run: "교차검토 실행" },
} as const;

/**
 * Controlled demo content. A product decision with a real trade-off in it,
 * because the page's claim is that the three answers *differ* in a way worth
 * reading; three paraphrases of one answer would illustrate the opposite.
 */
const DEMO = {
  en: {
    question: "We are changing prices next week. What should we watch out for?",
    answers: [
      "Ship the change behind a flag and keep the announcement one week behind the deploy, so a rollback costs nothing publicly.",
      "The migration itself is low risk. The invoice preview is generated at request time, so anyone mid-checkout during the deploy sees the old total on a page that charges the new one.",
      "Hold the announcement until the flag has been on for a full billing cycle. Anything shorter and the first renewal lands after the press, not before it.",
    ],
  },
  ko: {
    question: "다음 주에 가격을 바꾸려고 합니다. 무엇을 주의해야 할까요?",
    answers: [
      "플래그 뒤에서 먼저 배포하고 공지는 일주일 뒤로 미루세요. 그래야 되돌릴 때 공개적인 비용이 들지 않습니다.",
      "마이그레이션 자체는 위험이 낮습니다. 문제는 청구서 미리보기가 요청 시점에 생성된다는 점이라, 배포 중 결제하던 사용자는 옛 금액이 적힌 화면에서 새 금액이 청구됩니다.",
      "플래그를 한 번의 청구 주기 동안 켜 둔 뒤에 공지하세요. 그보다 짧으면 첫 갱신이 공지 이전이 아니라 이후에 발생합니다.",
    ],
  },
} as const;

/**
 * The review content, authored here rather than taken from
 * `mockComparisonReview`.
 *
 * Two reasons, both about the published image rather than about testing. The
 * shared fixture's body is Korean whatever `lang` says, so an English capture
 * came out with English chrome around Korean findings. And its subject is
 * deployment ordering, which has nothing to do with the pricing question the
 * comparison capture asks, so the two images told unrelated stories while
 * sitting one section apart on the same page.
 *
 * Editing the shared fixture was the other option and is the worse one: other
 * specs assert on those exact Korean strings.
 */
const REVIEW_CONTENT = {
  en: {
    consensus: "All three answers agree the change should ship behind a flag before it is announced.",
    consensusQuotes: ["Ship the change behind a flag", "keep the announcement one week behind"],
    issue: "When to announce",
    positions: [
      "One week after the deploy.",
      "Only once the invoice preview is fixed.",
      "After a full billing cycle has passed.",
    ],
    contradiction: "The answers disagree on how long to wait before announcing.",
    contradictionQuote: "Hold the announcement until the flag has been on for a full billing cycle",
    missing: "No answer says what happens to subscribers already on an annual term.",
    verify: "Whether the invoice preview is cached is asserted, not established.",
    synthesis: "Ship behind the flag first, fix the invoice preview, then decide the announcement date from the billing cycle.",
    limitation: "This review compares the supplied answers and does not verify facts externally.",
    assessments: [
      { strengths: ["Gives a concrete sequence."], cautions: ["Does not say what a rollback costs internally."] },
      { strengths: ["Names the actual failure, not the general risk."], cautions: ["Offers no announcement date."] },
      { strengths: ["Ties the date to something measurable."], cautions: ["Assumes one cycle is long enough."] },
    ],
  },
  ko: {
    consensus: "세 답변 모두 공지 전에 플래그 뒤에서 먼저 배포하라는 데 동의합니다.",
    consensusQuotes: ["플래그 뒤에서 먼저 배포하고", "공지는 일주일 뒤로 미루세요"],
    issue: "공지 시점",
    positions: [
      "배포 일주일 뒤에 공지합니다.",
      "청구서 미리보기를 고친 뒤에 공지합니다.",
      "한 번의 청구 주기가 지난 뒤에 공지합니다.",
    ],
    contradiction: "공지까지 얼마나 기다려야 하는지에 대해 답변이 서로 다릅니다.",
    contradictionQuote: "플래그를 한 번의 청구 주기 동안 켜 둔 뒤에 공지하세요",
    missing: "이미 연간 약정 중인 구독자가 어떻게 되는지는 어느 답변도 말하지 않습니다.",
    verify: "청구서 미리보기가 캐시되는지는 주장되었을 뿐 확인되지 않았습니다.",
    synthesis: "플래그 뒤에서 먼저 배포하고 청구서 미리보기를 고친 뒤, 공지 시점은 청구 주기를 기준으로 정합니다.",
    limitation: "이 검토는 제공된 답변끼리만 비교하며 외부 사실 검증을 하지 않습니다.",
    assessments: [
      { strengths: ["구체적인 순서를 제시합니다."], cautions: ["되돌릴 때의 내부 비용은 말하지 않습니다."] },
      { strengths: ["일반적인 위험이 아니라 실제 실패 지점을 짚습니다."], cautions: ["공지 시점을 제시하지 않습니다."] },
      { strengths: ["측정 가능한 기준에 공지 시점을 연결합니다."], cautions: ["한 주기면 충분하다고 가정합니다."] },
    ],
  },
} as const;

const RESPONSE_MAP = [
  { responseId: "A", messageId: "21111111-1111-4111-8111-111111111111", modelId: reviewModels[0], modelName: "GPT-5.4 mini" },
  { responseId: "B", messageId: "31111111-1111-4111-8111-111111111111", modelId: reviewModels[1], modelName: "Claude Haiku 4.5" },
  { responseId: "C", messageId: "41111111-1111-4111-8111-111111111111", modelId: reviewModels[2], modelName: "Gemini 3.5 Flash-Lite" },
] as const;

async function mockMarketingReview(page: Page, lang: (typeof LOCALES)[number]) {
  const c = REVIEW_CONTENT[lang];
  await page.route(
    "**/api/conversations/qa-conversation/comparison-reviews",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            promptMessageId: "11111111-1111-4111-8111-111111111111",
            assistantMessageIds: RESPONSE_MAP.map((r) => r.messageId),
            responses: RESPONSE_MAP.map(({ messageId, modelId, modelName }) => ({
              messageId,
              modelId,
              modelName,
            })),
            estimatedCredits: 4,
            reviewerClass: "Advanced",
            freeMonthlyReviews: 3,
            disclaimer: c.limitation,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "review-marketing",
          result: {
            primary: {
              reviewerModelId: "mistral-medium-3-1",
              result: {
                consensus: [
                  {
                    text: c.consensus,
                    citations: [
                      { responseId: "A", quote: c.consensusQuotes[0], verified: true },
                      { responseId: "B", quote: c.consensusQuotes[1], verified: true },
                    ],
                    verified: true,
                  },
                ],
                differences: [
                  {
                    issue: c.issue,
                    positions: RESPONSE_MAP.map((r, index) => ({
                      responseId: r.responseId,
                      position: c.positions[index],
                      quote: c.positions[index],
                      verified: index < 2,
                    })),
                  },
                ],
                contradictions: [
                  {
                    text: c.contradiction,
                    citations: [
                      { responseId: "C", quote: c.contradictionQuote, verified: true },
                    ],
                    verified: true,
                  },
                ],
                missingPoints: [c.missing],
                verificationNeeded: [c.verify],
                modelAssessments: RESPONSE_MAP.map((r, index) => ({
                  responseId: r.responseId,
                  strengths: c.assessments[index].strengths,
                  cautions: c.assessments[index].cautions,
                })),
                synthesis: c.synthesis,
                confidence: "medium",
                limitations: [c.limitation],
                groundingStats: { totalCitations: 4, verifiedCitations: 4 },
              },
            },
            secondary: null,
            agreement: null,
          },
          responseMap: RESPONSE_MAP,
          reviewerModelId: "mistral-medium-3-1",
          usageCredits: 4,
          cached: false,
          disclaimer: c.limitation,
        }),
      });
    }
  );
}

/**
 * Writes one capture as WebP.
 *
 * The conversion happens here rather than in a follow-up script so that
 * regenerating the assets stays the single command in this file's header. A
 * two-step procedure is a procedure half of which gets skipped, and the whole
 * reason this generator exists is that the asset it replaces had no repeatable
 * procedure at all.
 *
 * WebP at quality 82 rather than PNG: these are 16 screenshots of a mostly
 * flat UI, and as PNG they came to 1.7MB in the repository for images a
 * visitor loads at most two of.
 */
async function writeAsset(shot: Buffer, name: string) {
  await sharp(shot).webp({ quality: 82 }).toFile(`${OUT}/${name}.webp`);
}

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
});

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Marketing captures are generated on one engine so the published asset does not change with the runner's font stack."
  );
});

/**
 * Waits until nothing is still streaming, so no capture lands mid-answer.
 *
 * Below 768px the comparison is a tab layout: one panel is on screen and the
 * other two are mounted but hidden, so waiting for all three visible would
 * wait forever. The mobile crop legitimately shows one answer plus its tabs,
 * which is what the product does at that width.
 */
async function waitForAnswers(
  page: Page,
  answers: readonly string[],
  viewportWidth: number
) {
  const expected = viewportWidth < 768 ? answers.slice(0, 1) : answers;
  for (const answer of expected) {
    await expect(
      page.getByText(answer.slice(0, 40), { exact: false }).first()
    ).toBeVisible({ timeout: 15_000 });
  }
}

for (const theme of THEMES) {
  for (const crop of CROPS) {
    for (const lang of LOCALES) {
      const suffix = `${theme}-${crop.name}-${lang}`;

      test(`comparison capture ${suffix}`, async ({ page }) => {
        const demo = DEMO[lang];
        await enterConversation(page, {
          theme,
          lang,
          viewport: crop.viewport,
          selectedModels: [...reviewModels],
          modelStub: Object.fromEntries(
            reviewModels.map((modelId, index) => [
              modelId,
              { kind: "success" as const, chunks: [demo.answers[index]] },
            ])
          ),
        });

        await submitComposer(page, demo.question, crop.viewport.width);
        await waitForAnswers(page, demo.answers, crop.viewport.width);
        await freezeAnimations(page);

        await writeAsset(
          await page.screenshot({ animations: "disabled" }),
          `comparison-${suffix}`
        );
      });

      test(`review findings capture ${suffix}`, async ({ page }) => {
        // Composed by hand rather than through `enterConversation`, which
        // lands *inside* a conversation. The review entry lives on a
        // conversation opened from the welcome screen, so this follows the
        // path `tests/e2e/comparison-review.spec.ts` established, plus the
        // determinism `enterConversation` would otherwise have applied.
        await prepareGuestPage(page, lang);
        await mockAuthenticatedApi(page, { selectedModels: [...reviewModels] });
        await setDeterministicTheme(page, theme);
        await suppressTransientUi(page);
        await mockConversationHistory(page);
        await mockMarketingReview(page, lang);
        // Taller than the crop's own viewport, on purpose. The findings are a
        // five-part result; at 900px the last two were cut mid-card and the
        // dialog backdrop showed as a dark band along the bottom edge of the
        // published image. The width is the crop's real width, so the layout
        // is exactly the one that width produces; only the window is taller so
        // the whole result is in frame.
        await page.setViewportSize({
          width: crop.viewport.width,
          height: crop.name === "mobile" ? 1_400 : 1_500,
        });
        await page.goto(`/chat?lang=${lang}`);
        await expectThemeApplied(page, theme);
        await openReviewConversation(page);

        // Run the review the way a person does, so the captured state is one
        // the product actually produces rather than a hand-mounted component.
        const labels = REVIEW_LABELS[lang];
        await page.getByRole("button", { name: labels.title }).first().click();
        const dialog = page.getByRole("dialog", { name: labels.title });
        await expect(dialog.getByTestId("comparison-review-setup")).toBeVisible({
          timeout: 20_000,
        });
        await dialog.getByRole("button", { name: labels.run }).click();
        const result = dialog.getByTestId("ai-review-result");
        await expect(result).toBeVisible({ timeout: 20_000 });
        await freezeAnimations(page);

        // Clip below the badge row. See rule 2 in this file's header: that row
        // carries the credit figure, and a credit figure inside a published
        // PNG is the exact defect that retired the previous asset.
        const resultBox = await result.boundingBox();
        const badge = dialog.getByTestId("ai-review-compared-count");
        const badgeBox = (await badge.count())
          ? await badge.boundingBox()
          : await dialog.getByTestId("ai-review-used-credits").boundingBox();
        expect(resultBox, "review result box").not.toBeNull();
        expect(badgeBox, "badge row box").not.toBeNull();
        if (!resultBox || !badgeBox) return;

        const top = badgeBox.y + badgeBox.height + 12;
        const shot = await page.screenshot({
          animations: "disabled",
          clip: {
            x: resultBox.x,
            y: top,
            width: resultBox.width,
            // Clamped to the viewport: the result scrolls past the fold, and an
            // unclamped height captured the dialog backdrop below it as a
            // dark band across the bottom of the published image.
            height: Math.max(
              120,
              Math.min(
                resultBox.y + resultBox.height - top,
                (crop.name === "mobile" ? 1_400 : 1_500) - top - 8
              )
            ),
          },
        });
        await writeAsset(shot, `review-findings-${suffix}`);
      });
    }
  }
}
