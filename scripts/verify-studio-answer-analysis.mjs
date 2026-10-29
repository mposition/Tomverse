// Loopback-only behavioural verification of the real Studio analysis UI.
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
const dir = await mkdtemp(join(tmpdir(), "tomverse-studio-analysis-"));
let browser, server;
try {
  await build({
    entryPoints: [resolve(root, "tests/fixtures/studioAnswerAnalysis.tsx")], outfile: join(dir, "ui.js"),
    bundle: true, format: "esm", platform: "browser", jsx: "automatic",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' }, logLevel: "error",
  });
  const componentCss = await readFile(join(dir, "ui.css"), "utf8");
  const css = await postcss([tailwind({ base: root })]).process(await readFile(resolve(root, "app/globals.css"), "utf8"), { from: resolve(root, "app/globals.css") });
  await writeFile(join(dir, "ui.css"), css.css + "\n" + componentCss);
  server = createServer(async (req, res) => {
    if (req.url === "/tomverse-logo.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(await readFile(resolve(root, "public/tomverse-logo.png")));
    } else if (req.url === "/ui.js" || req.url === "/ui.css") {
      const file = req.url === "/ui.css" ? "ui.css" : "ui.js";
      res.setHeader("Content-Type", file.endsWith("css") ? "text/css" : "text/javascript");
      res.end(await readFile(join(dir, file)));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end('<html lang="ko" class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
  const mock = await mockComparisonReview(page, { deferRun: true, withSecondary: true });
  const endpoint = /\/api\/conversations\/qa-conversation\/comparison-reviews(?:\?.*)?$/;
  let setup, result, getCount = 0;
  page.on("response", async (response) => {
    if (!endpoint.test(response.url())) return;
    if (response.request().method() === "GET") { getCount++; setup = await response.json(); }
    else result = await response.json();
  });
  const feedback = [];
  let webCalls = 0;
  await page.route("**/comparison-reviews/item-feedback", async (route) => {
    feedback.push(route.request().method()); await route.fulfill({ json: { verdict: null } });
  });
  await page.route("**/comparison-reviews/verify-item", async (route) => {
    webCalls++; await route.fulfill({ json: { status: "inconclusive", summary: "Fixture external result", usageCredits: 1 } });
  });
  await page.goto(base);
  await expect.poll(() => getCount).toBe(1);
  assert.equal(mock.getRunCount(), 0, "opening the conversation does not analyze answers");
  const entry = page.getByTestId("studio-analysis-entry");
  await entry.getByRole("button").dblclick();
  await expect.poll(mock.getRunCount).toBe(1);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("progressbar")).toBeVisible();
  await page.screenshot({ path: resolve(root, ".tmp-studio-analysis-progress.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(entry.getByRole("button")).toBeFocused();
  await entry.getByRole("button").click();
  await expect(dialog.getByRole("progressbar")).toBeVisible();
  assert.equal(mock.getRunCount(), 1, "reopening a pending review does not submit again");
  await page.keyboard.press("Escape");
  mock.releaseRun();
  await expect(entry.getByRole("button", { name: "분석 결과 보기" })).toBeVisible();
  await expect(dialog).toBeHidden();
  await entry.getByRole("button").click();
  await expect(dialog.getByRole("heading", { name: "우선순위", exact: true })).toBeVisible();
  assert.deepEqual(mock.getRequestBody(), {
    promptMessageId: setup.promptMessageId, assistantMessageIds: setup.assistantMessageIds,
    reviewMode: "balanced", includeSynthesis: false,
  });
  await page.screenshot({ path: resolve(root, ".tmp-studio-analysis-summary.png") });
  await dialog.getByRole("tab", { name: "상세 검토", exact: true }).click();
  let workspace = dialog.locator('[data-testid="ai-review-workspace"]:visible');
  await workspace.getByRole("button", { name: "원문에서 보기" }).click();
  await expect(workspace.locator("mark")).toHaveText("먼저 배포부터 진행합니다.");
  await workspace.locator('[data-testid="ai-review-item-feedback-helpful"]:visible').click();
  await expect.poll(() => feedback.length).toBe(1);
  await workspace.getByRole("button", { name: /^4\./ }).click();
  assert.equal(webCalls, 0);
  await workspace.getByRole("button", { name: "웹으로 확인" }).click();
  await expect(workspace.getByText("Fixture external result", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "검토자 2", exact: true }).click();
  await dialog.getByRole("button", { name: "검토자 1", exact: true }).click();
  await expect(workspace.getByText("Fixture external result", { exact: false })).toBeVisible();
  await dialog.getByRole("tab", { name: "요약", exact: true }).click();
  await dialog.getByRole("tab", { name: "상세 검토", exact: true }).click();
  await expect(workspace.getByText("Fixture external result", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await entry.getByRole("button", { name: "분석 결과 보기" }).click();
  await expect(workspace.getByText("Fixture external result", { exact: false })).toBeVisible();
  assert.equal(mock.getRunCount(), 1);
  assert.equal(getCount, 1, "reopening and tab switching need no new lookup either");
  assert.equal(webCalls, 1);
  assert.doesNotMatch(await dialog.innerText(), /크레딧|credits|균형 검토|근거 중심|실행 중심/i);
  await page.screenshot({ path: resolve(root, ".tmp-studio-analysis-detail.png") });
  await page.evaluate(() => document.documentElement.className = "dark");
  await page.setViewportSize({ width: 1024, height: 800 });
  assert.equal(await dialog.evaluate((element) => element.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(root, ".tmp-studio-analysis-dark.png") });

  // The server cache survives a full browser remount; the exact mode is supplied.
  const saved = result, originalSetup = setup;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === "GET") {
      const query = new URL(route.request().url()).searchParams;
      assert.equal(query.get("reviewMode"), "balanced");
      assert.equal(query.get("includeSynthesis"), "false");
      await route.fulfill({ json: { ...originalSetup, storedReview: { ...saved, cached: true } } });
    } else await route.fallback();
  });
  await page.reload();
  await entry.getByRole("button", { name: "분석 결과 보기" }).click();
  await expect(dialog.getByRole("heading", { name: "우선순위", exact: true })).toBeVisible();
  assert.equal(mock.getRunCount(), 1);
  await page.keyboard.press("Escape");

  // Same ids with changed content are a new input, not a cached result.
  await page.route(endpoint, async (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { ...originalSetup, source: { ...originalSetup.source, responses: originalSetup.source.responses.map((response) => ({ ...response, content: response.content + " Changed answer." })) } } })
    : route.fallback());
  await page.getByRole("button", { name: "New answer", exact: true }).click();
  await entry.getByRole("button", { name: "Tomverse 답변 분석", exact: true }).click();
  await expect.poll(mock.getRunCount).toBe(2);
  await expect(dialog.getByRole("heading", { name: "우선순위", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Switch identity", exact: true }).click();
  await expect(entry.getByRole("button", { name: "Tomverse 답변 분석", exact: true })).toBeVisible();

  // Guest flow uses the same session cache without claiming server persistence.
  let guestRuns = 0;
  await page.route("**/api/chat/comparison-review/preview", (route) => route.fulfill({ json: { ...originalSetup, guest: true } }));
  await page.route("**/api/chat/comparison-review", async (route) => {
    guestRuns++; assert.ok(route.request().postDataJSON().idempotencyKey);
    await route.fulfill({ json: { ...saved, guest: true, persisted: false, webVerificationAvailable: false } });
  });
  await page.getByRole("button", { name: "Guest mode", exact: true }).click();
  await entry.getByRole("button").click();
  await expect(dialog.getByText("현재 대화에서 보관", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await entry.getByRole("button").click();
  await dialog.getByRole("tab", { name: "상세 검토", exact: true }).click();
  assert.equal(guestRuns, 1);

  const failedMock = await mockComparisonReview(page, { failRun: "first" });
  await page.reload();
  await entry.getByRole("button").click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  assert.equal(failedMock.getRunCount(), 1, "failure does not automatically retry");
  await dialog.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "우선순위", exact: true })).toBeVisible();
  assert.equal(failedMock.getRunCount(), 2);

  // Mobile has neither the new entry/modal nor a background analysis lookup.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(entry).toHaveCount(0); await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "New answer", exact: true }).waitFor();
  const mobileGets = getCount;
  await page.getByRole("button", { name: "New answer", exact: true }).click();
  await expect(entry).toHaveCount(0);
  assert.equal(getCount, mobileGets);
  assert.equal(mock.getRunCount(), 2);
  assert.deepEqual(errors, []);
  console.log("PASS: single execution, background completion, saved reopen/remount, tabs/reviewers/evidence, changed answers, identity isolation, guest reuse, no credit copy, desktop/dark/mobile exclusion.");
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
