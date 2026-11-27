// Mount the real Classic AI Review dialog against loopback fixtures and check
// what a newly finished answer does to it. No provider, DB or paid request.
//
//   node --import tsx scripts/verify-ai-review-dialog.mjs
//
// The bug this pins: ChatPageClient used to key the dialog on a counter bumped
// by every finished answer, so a third model finishing while a 2-of-3 review
// ran (or was being read) remounted the dialog onto its setup step. The run
// still completed and was billed on the server, but the dialog now looked the
// saved result up by the new 3-answer turn and could not find it, and the run
// button was one click away from a second, separately billed review.
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mockComparisonReview } from "../tests/e2e/support/comparison-review-fixtures.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "tomverse-ai-review-dialog-"));
const endpoint = /\/api\/conversations\/qa-conversation\/comparison-reviews(?:\?.*)?$/;
let browser, server;
try {
  await build({
    entryPoints: [resolve(root, "tests/fixtures/aiReviewDialogRevision.tsx")],
    outfile: join(dir, "ui.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
    logLevel: "error",
  });
  const css = await postcss([tailwind({ base: root })]).process(
    await readFile(resolve(root, "app/globals.css"), "utf8"),
    { from: resolve(root, "app/globals.css") },
  );
  await writeFile(join(dir, "ui.css"), css.css);
  server = createServer(async (req, res) => {
    if (req.url === "/ui.js" || req.url === "/ui.css") {
      // A fixed name, not the request path, reaches the filesystem.
      const file = req.url === "/ui.css" ? "ui.css" : "ui.js";
      res.setHeader("Content-Type", file.endsWith("css") ? "text/css" : "text/javascript");
      res.end(await readFile(join(dir, file)));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<html lang="ko" class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>',
      );
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === base ? route.fallback() : route.abort(),
  );
  const gets = [];
  page.on("request", (request) => {
    if (endpoint.test(request.url()) && request.method() === "GET") gets.push(request.url());
  });
  const answerFinished = () => page.evaluate(() => window.__tomverseAnswerFinished?.());
  // With no analytics runtime the product events queue in sessionStorage
  // (lib/productAnalyticsClient.ts), which is where they can be counted.
  const startedEvents = () =>
    page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("tomverse_analytics_pending_events_v1") || "[]")
        .filter((event) => event.eventName === "comparison_review_started").length,
    );
  // Long enough for a refetch the dialog should not make to have been sent.
  const settle = () => page.waitForTimeout(400);

  const mock = await mockComparisonReview(page, { deferRun: true, withSecondary: true });
  await page.goto(base);
  const setupScreen = page.getByTestId("comparison-review-setup");
  await expect(setupScreen).toBeVisible();
  assert.equal(gets.length, 1);

  // 1. On the setup step a finished answer still refreshes the setup: its
  //    scope, estimate and saved-result lookup describe the latest turn.
  await answerFinished();
  await expect.poll(() => gets.length).toBe(2);
  await expect(setupScreen).toBeVisible();

  // 2. A run in flight survives answers finishing: no remount, no refetch.
  await page.getByRole("button", { name: /교차검토 실행/ }).click();
  await expect.poll(mock.getRunCount).toBe(1);
  const runningButton = page.getByRole("button", { name: /답변을 검토하는 중/ });
  await expect(runningButton).toBeVisible();
  await answerFinished();
  await answerFinished();
  await settle();
  assert.equal(gets.length, 2, "a finished answer re-fetched the setup under a running review");
  await expect(runningButton).toBeVisible();
  await expect(runningButton).toBeDisabled();
  await expect(page.getByTestId("comparison-review-loading")).toHaveCount(0);

  // 3. The billed result arrives in the same dialog and stays while more
  //    answers finish -- it is never swapped for the setup step.
  mock.releaseRun();
  const result = page.getByTestId("ai-review-result");
  await expect(result).toBeVisible();
  await answerFinished();
  await settle();
  await expect(result).toBeVisible();
  await expect(setupScreen).toHaveCount(0);
  assert.equal(gets.length, 2, "a finished answer re-fetched the setup over a displayed result");
  assert.equal(mock.getRunCount(), 1, "the review ran more than once");
  assert.equal(await startedEvents(), 1, "a run this dialog started is counted as started");

  // 4. Leaving the result for the setup step catches up with the answers that
  //    finished meanwhile, exactly once.
  await page.getByRole("button", { name: "검토 기준 변경" }).click();
  await expect.poll(() => gets.length).toBe(3);
  await expect(setupScreen).toBeVisible();
  await settle();
  assert.equal(gets.length, 3);
  assert.equal(mock.getRunCount(), 1);

  // 5. The server says this exact review is already running (another tab,
  //    Studio, or a stream this dialog lost): 409 DUPLICATE_REQUEST. The
  //    dialog says so in its own words -- not a generic failure, not the
  //    server's English -- polls nothing, and leaves the run button available:
  //    pressed again it is refused while the run is in flight and gets the
  //    saved row (the route's cache path) once it has finished.
  const saved = mock.getStoredReview();
  const alreadyRunning = "이 답변들의 교차검토가 이미 실행 중입니다. 잠시 후 다시 열어 결과를 확인해 주세요.";
  let duplicatePosts = 0;
  let duplicateAnswer = "already-running";
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    duplicatePosts += 1;
    if (duplicateAnswer === "saved") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...saved, cached: true, usageCredits: 0 }),
      });
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "This request is already being processed.", code: "DUPLICATE_REQUEST" }),
    });
  });
  const getsBeforeDuplicate = gets.length;
  const startedBeforeDuplicate = await startedEvents();
  const runButton = page.getByRole("button", { name: /교차검토 실행/ });
  const errorBox = page.getByTestId("comparison-review-error");
  await runButton.click();
  await expect(errorBox).toHaveText(alreadyRunning);
  await expect(runButton).toBeEnabled();
  // Longer than the first poll any waiting client would have made.
  await page.waitForTimeout(5_000);
  assert.equal(gets.length, getsBeforeDuplicate, "the dialog sent a request after the 409");
  assert.equal(duplicatePosts, 1);
  assert.equal(await startedEvents(), startedBeforeDuplicate, "a refused attempt was counted as a started review");

  await runButton.click();
  await expect.poll(() => duplicatePosts).toBe(2);
  await expect(errorBox).toHaveText(alreadyRunning);
  await expect(runButton).toBeEnabled();

  duplicateAnswer = "saved";
  await runButton.click();
  await expect(result).toBeVisible();
  await expect(errorBox).toHaveCount(0);
  assert.equal(duplicatePosts, 3);
  assert.equal(gets.length, getsBeforeDuplicate, "no lookup but the run itself was needed");
  assert.equal(mock.getRunCount(), 1);

  // 6. Guest: the setup previews the page's latest local turn, so an answer
  //    finishing on the setup step is included in the preview and in the run;
  //    once the run starts, more answers change nothing.
  const guestPreviews = [];
  const guestRuns = [];
  const guestGate = { open: () => {} };
  const guestRunGate = new Promise((done) => { guestGate.open = done; });
  await page.route("**/api/chat/comparison-review/preview", async (route) => {
    const body = route.request().postDataJSON();
    guestPreviews.push(body.responses.length);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        guest: true,
        guestTrial: { limit: 1, used: 0, remaining: 1 },
        responses: body.responses.map(({ messageId, modelId }) => ({ messageId, modelId, modelName: modelId })),
        estimatedCredits: 8,
        dualReview: false,
        reviewerClass: "Advanced",
        disclaimer: "This compares only supplied answers.",
      }),
    });
  });
  await page.route("**/api/chat/comparison-review", async (route) => {
    guestRuns.push(route.request().postDataJSON().responses.length);
    await guestRunGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...saved, guest: true, persisted: false, webVerificationAvailable: false }),
    });
  });
  await page.goto(`${base}/?mode=guest`);
  await expect(setupScreen).toBeVisible();
  assert.deepEqual(guestPreviews, [2]);
  await answerFinished();
  await expect.poll(() => guestPreviews.length).toBe(2);
  assert.equal(guestPreviews[1], 3, "the guest setup was refreshed with the answers captured when it opened");
  await expect(setupScreen).toBeVisible();
  await page.getByRole("button", { name: /교차검토 실행/ }).click();
  await expect.poll(() => guestRuns.length).toBe(1);
  assert.equal(guestRuns[0], 3, "the guest run did not send the turn its setup previewed");
  await answerFinished();
  await settle();
  assert.equal(guestPreviews.length, 2, "a finished answer re-previewed the guest setup under a running review");
  guestGate.open();
  await expect(result).toBeVisible();
  await answerFinished();
  await settle();
  await expect(result).toBeVisible();
  assert.equal(guestPreviews.length, 2);
  assert.equal(guestRuns.length, 1);

  assert.deepEqual(errors, []);
  console.log(
    "PASS: Classic AI Review dialog; setup refreshes on new answers (guest included), a running review and a displayed result survive them, the setup catches up afterwards, and an already-running review is reported in the dialog's own words, with no polling.",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
