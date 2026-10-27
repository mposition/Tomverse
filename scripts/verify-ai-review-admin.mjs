// Real Admin components and real shared file verification; synthetic evidence only.
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { buildCase, layOutRun } from "../tests/fixtures/aiReviewJudgedRun.mjs";
import { readAiReviewJudgedRunCatalog } from "../lib/aiReviewJudgedRunReport.ts";
import { readAiReviewPreparationCatalog } from "../lib/aiReviewPreparationServer.ts";
import { aiReviewM5Progress } from "../lib/aiReviewM5Progress.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "tomverse-ai-review-admin-"));
let browser, server;
try {
  const runs = join(dir, "runs");
  await mkdir(join(runs, "02-complete"), { recursive: true });
  await mkdir(join(runs, "01-incomplete"));
  const fixtures = [
    buildCase({ id: "review-ko-001", invents: true }),
    buildCase({ id: "review-ko-002", reports: false }),
    buildCase({
      id: "review-en-003",
      language: "en",
      taskType: "planning_decision",
    }),
  ];
  layOutRun(join(runs, "02-complete"), fixtures);
  layOutRun(join(runs, "01-incomplete"), fixtures, { bundles: [] });
  const catalog = readAiReviewJudgedRunCatalog(runs);
  const preparation = readAiReviewPreparationCatalog();
  const progress = aiReviewM5Progress(preparation, { state: "unconfigured", reports: [], problems: [] });
  assert.equal(catalog.reports[0].result.aggregable, true);
  await build({
    entryPoints: [resolve(root, "tests/fixtures/aiReviewAdminWorkspace.tsx")],
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
  await writeFile(
    join(dir, "ui.css"),
    css.css +
      (await readFile(
        resolve(root, "app/(site)/(application)/admin/admin-theme.css"),
        "utf8",
      )),
  );
  server = createServer(async (req, res) => {
    if (req.url === "/catalog.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(catalog));
    } else if (req.url === "/preparation.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ catalog: preparation, progress }));
    } else if (req.url === "/ui.js" || req.url === "/ui.css") {
      res.setHeader(
        "Content-Type",
        req.url.endsWith("css") ? "text/css" : "text/javascript",
      );
      res.end(await readFile(join(dir, req.url.slice(1))));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>',
      );
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === base
      ? route.fallback()
      : route.abort(),
  );
  await page.goto(base);
  await expect(page.getByTestId("judged-metric")).toHaveCount(2);
  await expect(page.getByText("33.3%", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "과제별", exact: true }).click();
  await expect(
    page.getByRole("rowheader", { name: "planning_decision" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Case별 근거" })
    .selectOption("invented");
  await expect(page.getByRole("button", { name: /^근거 보기:/ })).toHaveCount(
    1,
  );
  const inspect = page.getByRole("button", {
    name: "근거 보기: review-ko-001",
  });
  await inspect.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("answer c of review-ko-001", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("TEST (not a person)", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(inspect).toBeFocused();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 내보내기" }).click();
  const download = await downloaded;
  const saved = join(dir, "export.json");
  await download.saveAs(saved);
  assert.deepEqual(
    JSON.parse(await readFile(saved, "utf8")),
    catalog.reports[0],
  );
  await page.getByRole("combobox", { name: "Case별 근거" }).selectOption("all");
  await page
    .getByRole("textbox", { name: "Case ID 또는 질문 검색" })
    .fill("does-not-exist");
  await expect(page.getByRole("status")).toHaveText(
    "조건에 맞는 case가 없습니다.",
  );
  await page.getByRole("textbox", { name: "Case ID 또는 질문 검색" }).fill("");
  await page.screenshot({
    path: resolve(root, ".tmp-ai-review-admin-desktop.png"),
    fullPage: true,
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .locator("main")
      .evaluate((element) => element.setAttribute("data-admin-theme", "dark"));
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await inspect.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    assert.equal(
      await page
        .getByRole("dialog")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await page.getByRole("button", { name: "근거 닫기" }).click();
  }
  await page.screenshot({
    path: resolve(root, ".tmp-ai-review-admin-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "평가 실행" })
    .selectOption("01-incomplete");
  await expect(page.getByTestId("judged-run-refused")).toBeVisible();
  await expect(page.getByTestId("judged-metric")).toHaveCount(0);
  await page.goto(`${base}/prepare`);
  await page.getByTestId("ai-review-preparation").locator(":scope > summary").click();
  await page.getByRole("textbox", { name: "검토 메모·미결 사항" }).fill("Browser draft, not a judgement");
  const editDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "편집 초안 내려받기" }).click();
  const editPath = join(dir, "proposal.json");
  await (await editDownload).saveAs(editPath);
  const proposal = JSON.parse(await readFile(editPath, "utf8"));
  assert.equal(proposal.proposedCase.status, "candidate");
  assert.equal(proposal.proposedCase.adoptedBy, null);
  assert.equal(proposal.proposedCase.notes, "Browser draft, not a judgement");
  const sampleDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "표본 구성 초안 내려받기" }).click();
  const samplePath = join(dir, "sample.json");
  await (await sampleDownload).saveAs(samplePath);
  assert.equal(JSON.parse(await readFile(samplePath, "utf8")).dataset.frozenDigest, null);
  const thresholds = page.getByTestId("ai-review-threshold-draft");
  await thresholds.locator("summary").click();
  const thresholdDownload = page.getByRole("button", { name: "미승인 기준 초안 내려받기" });
  await expect(thresholdDownload).toBeDisabled();
  await page.getByRole("textbox", { name: "임계값 버전" }).fill("browser-fixture-only");
  for (const input of await thresholds.getByRole("spinbutton").all()) await input.fill("0.5");
  await page.getByRole("spinbutton", { name: "블라인드 검토 최소 사례 수" }).fill("20");
  await page.getByRole("combobox", { name: "음성 사례 부분집합" }).selectOption("diagnostic");
  await expect(thresholdDownload).toBeEnabled();
  const thresholdEvent = page.waitForEvent("download");
  await thresholdDownload.click();
  const thresholdPath = join(dir, "threshold.json");
  await (await thresholdEvent).saveAs(thresholdPath);
  const threshold = JSON.parse(await readFile(thresholdPath, "utf8"));
  assert.equal(threshold.approvedBy, null);
  assert.equal(threshold.maxWilsonUpper.inventedFindingRate, 0.5);
  assert.equal("falseConsensusRate" in threshold.maxWilsonUpper, false);
  await expect(page.getByTestId("judged-metric")).toHaveCount(0);
  await expect(page.getByTestId("ai-review-m5-progress")).toContainText("승급 판정이 아닙니다");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.screenshot({ path: resolve(root, ".tmp-ai-review-preparation-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.screenshot({ path: resolve(root, ".tmp-ai-review-preparation-desktop.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Admin results, source evidence, candidate/sample/threshold draft exports, unsigned defaults, operational inventory, refusal, mobile and dark mode.",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
