import { expect, test, type Page } from "@playwright/test";
import {
  enterConversation,
  mockDeepResearchStatus,
} from "./support/chat-state-fixtures";
import { expectNoHorizontalOverflow } from "./support/app-fixtures";

// The assistant answer header is one row carrying four independent facts:
// which model answered, which run mode it is in, that the turn is live, and
// how to stop it. Before this suite the row had no width policy at all, so a
// narrow viewport made every item wrap its own text -- the model name broke
// across two lines and the stop button's two-syllable Korean label split into
// one character per line.
//
// The fix is a priority, not a removal: only the model name gives way (it
// truncates, keeping the full string in `title` next to a logo that already
// names the provider), and every status control keeps its label whole. So
// these tests assert both halves. A row that fits because the Deep Research
// badge stopped rendering is the regression #792 already had to undo, and
// `stillReportsItsMode` below is what would catch it a second time.

const DEEP_RESEARCH_MODEL = "perplexity/sonar-deep-research";
const DEEP_RESEARCH_MODEL_NAME = "Perplexity Sonar Deep Research";
const MODEL_B = "claude-sonnet-5";
const MODEL_C = "gemini-3-6-flash";
const SHORT_ANSWER = "The capital of France is Paris.";

// The single-line ceiling. The row's tallest item is the 24px model logo
// (ModelLogo size="sm" -> h-6), so anything meaningfully above that is a
// second line. 30px leaves room for the badge's py-0.5 without leaving room
// for a wrap of the 11px/~16px text.
const SINGLE_ROW_MAX_HEIGHT = 30;

const NARROW_VIEWPORTS = [
  { name: "390px (Pixel 5 CSS width)", width: 390, height: 844 },
  { name: "320px (narrowest supported)", width: 320, height: 568 },
] as const;

async function startRunningDeepResearch(
  page: Page,
  viewport: { width: number; height: number }
) {
  await enterConversation(page, {
    theme: "light",
    viewport,
    selectedModels: [MODEL_B, MODEL_C],
    usagePatch: {
      plan: "Pro",
      balances: { planRemainingCredits: 3000, dailyRemainingCredits: 300 },
      limits: { creditsDay: 300, creditsMonth: 3000 },
    },
    modelStub: {
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [DEEP_RESEARCH_MODEL]: { kind: "async-job", jobId: "qa-job-progress" },
    },
  });
  // Held pending: the job never resolves, so the panel stays in the running
  // state -- which for an asynchronous job is where it spends the whole run.
  await mockDeepResearchStatus(page, "hold");

  await page.getByTestId("chat-textarea").fill("Compare renewable energy adoption across three regions.");
  await page.locator('button[aria-controls="chat-input-popover"]').nth(0).click();
  await page.getByTestId("tools-deep-research-row").click();
  await page.getByTestId("deep-research-depth-standard").click();
  await page.getByTestId("deep-research-confirm-start").click();
  await expect(page.getByTestId("deep-research-confirm-start")).toHaveCount(0);

  if (viewport.width < 768) {
    // Confirming swaps the deep-research model into the last slot; the mobile
    // shell opens on the first tab, so the running panel has to be selected.
    await page
      .locator(`[data-testid="mobile-model-tab"][data-model-id="${DEEP_RESEARCH_MODEL}"]`)
      .click();
  }

  const header = page
    .locator(
      `[data-testid="chat-message"][data-model-id="${DEEP_RESEARCH_MODEL}"] [data-testid="assistant-message-header"]`
    )
    .last();
  await expect(header).toBeVisible();
  // The stop control only exists while the turn is actually running, so
  // waiting on it is what makes this the four-item worst case rather than a
  // finished row that happens to be narrower.
  await expect(header.getByTestId("stop-this-response")).toBeVisible();
  return header;
}

test.describe("Assistant answer header @ui-risk", () => {
  for (const viewport of NARROW_VIEWPORTS) {
    test(`the running Deep Research header stays one row at ${viewport.name}`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const header = await startRunningDeepResearch(page, viewport);

      const headerBox = await header.boundingBox();
      expect(headerBox).not.toBeNull();
      expect(headerBox!.height).toBeLessThanOrEqual(SINGLE_ROW_MAX_HEIGHT);

      // Every status control keeps its own label on one line. Measuring the
      // box rather than the class is the point: "중지" splitting into "중" /
      // "지" showed up as a two-line button, not as a missing utility.
      for (const testId of ["search-status-badge", "stop-this-response"]) {
        const control = header.getByTestId(testId);
        await expect(control).toBeVisible();
        const box = await control.boundingBox();
        expect(box, `${testId} has no box`).not.toBeNull();
        expect(box!.height, `${testId} wrapped onto a second line`).toBeLessThanOrEqual(
          SINGLE_ROW_MAX_HEIGHT
        );
      }

      await expectNoHorizontalOverflow(page);
    });

    test(`the header still reports its mode and model at ${viewport.name}`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const header = await startRunningDeepResearch(page, viewport);

      // stillReportsItsMode. The badge names the run mode and is not
      // decoration: a narrow row is never a reason to drop it, and the model
      // name containing the same words is not a reason either, because other
      // models can run Deep Research too.
      await expect(header.getByTestId("search-status-badge")).toHaveAttribute(
        "data-search-status",
        "deep-research"
      );

      // The name is the one item allowed to give way, so it has to stay
      // recoverable: the full string lives in `title`, and the visible text
      // ends in an ellipsis rather than a line break.
      const name = header.getByTestId("assistant-message-model-name");
      await expect(name).toHaveAttribute("title", DEEP_RESEARCH_MODEL_NAME);
      const nameStyle = await name.evaluate((node) => {
        const style = getComputedStyle(node);
        return { textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
      });
      expect(nameStyle.textOverflow).toBe("ellipsis");
      expect(nameStyle.whiteSpace).toBe("nowrap");
    });
  }
});
