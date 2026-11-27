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

  // 4. Leaving the result for the setup step catches up with the answers that
  //    finished meanwhile, exactly once.
  await page.getByRole("button", { name: "검토 기준 변경" }).click();
  await expect.poll(() => gets.length).toBe(3);
  await expect(setupScreen).toBeVisible();
  await settle();
  assert.equal(gets.length, 3);
  assert.equal(mock.getRunCount(), 1);

  assert.deepEqual(errors, []);
  console.log(
    "PASS: Classic AI Review dialog; setup refreshes on new answers, a running review and a displayed result survive them, and the setup catches up afterwards.",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
