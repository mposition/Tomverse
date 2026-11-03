// Mount the real UI against loopback fixtures. No provider, DB or paid request.
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
const dir = await mkdtemp(join(tmpdir(), "tomverse-ai-review-ui-"));
let browser, server;
try {
  await build({
    entryPoints: [resolve(root, "tests/fixtures/aiReviewWorkspace.tsx")],
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
      res.setHeader(
        "Content-Type",
        file.endsWith("css") ? "text/css" : "text/javascript",
      );
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
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === base
      ? route.fallback()
      : route.abort(),
  );
  await mockComparisonReview(page, { withSecondary: true });
  const feedback = [];
  await page.route("**/comparison-reviews/item-feedback", async (route) => {
    feedback.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    await route.fulfill({ status: 200, json: { verdict: null } });
  });
  let webCalls = 0;
  await page.route("**/comparison-reviews/verify-item", async (route) => {
    webCalls++;
    await route.fulfill({
      status: 200,
      json: {
        status: "inconclusive",
        summary: "Fixture external result",
        usageCredits: 1,
      },
    });
  });
  await page.goto(base);
  await page
    .getByRole("button", { name: /교차검토 실행/ })
    .click()
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
  const workspace = page.locator('[data-testid="ai-review-workspace"]:visible');
  await expect(
    workspace.getByRole("heading", {
      name: "배포 순서에 대한 권고가 서로 다릅니다.",
    }),
  ).toBeVisible();
  await workspace.getByRole("button", { name: "원문에서 보기" }).click();
  await expect(workspace.locator("mark")).toHaveText(
    "먼저 배포부터 진행합니다.",
  );
  await expect(workspace.getByTestId("ai-review-source-answer")).toBeFocused();
  const helpful = workspace.locator(
    '[data-testid="ai-review-item-feedback-helpful"]:visible',
  );
  await helpful.click();
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  assert.equal(feedback[0].method, "PUT");
  await workspace.getByRole("button", { name: /^4\./ }).click();
  assert.equal(webCalls, 0, "navigation must not run a paid action");
  await workspace.getByRole("button", { name: "웹으로 확인" }).click();
  await expect(
    workspace.getByText("Fixture external result", { exact: false }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /검토자 2/ }).click();
  await page.getByRole("tab", { name: /검토자 1/ }).click();
  await expect(
    workspace.getByText("Fixture external result", { exact: false }),
  ).toBeVisible();
  assert.equal(webCalls, 1);
  await workspace.getByRole("button", { name: /^1\./ }).click();
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  await helpful.click();
  assert.equal(feedback[1].method, "DELETE");
  await expect(helpful).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({
    path: resolve(root, ".tmp-ai-review-user-desktop.png"),
    fullPage: true,
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => (document.documentElement.className = "dark"));
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await workspace.getByRole("button", { name: "원문에서 보기" }).click();
    await expect(
      workspace.getByTestId("ai-review-source-answer"),
    ).toBeFocused();
  }
  await page.screenshot({
    path: resolve(root, ".tmp-ai-review-user-mobile.png"),
    fullPage: true,
  });
  await mockComparisonReview(page, {longSource: true});
  await page.goto(base);
  await page.getByRole("button", {name: /교차검토 실행/}).click();
  await workspace.getByRole("button", {name: "원문에서 보기"}).click();
  await expect(workspace.locator("mark")).toBeInViewport({ratio: 1});
  assert.equal(await workspace.locator("mark").evaluate((element) => {
    const mark = element.getBoundingClientRect(), container = element.parentElement.getBoundingClientRect();
    return mark.top >= container.top && mark.bottom <= container.bottom;
  }), true, "source navigation reveals a quote below the original answer's scroll fold");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real review workspace; exact source, feedback submit/withdraw, web opt-in, reviewer state, 1600/390/320px and dark mode.",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
