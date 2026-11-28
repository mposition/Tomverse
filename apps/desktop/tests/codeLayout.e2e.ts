import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { codeModelControl } from "./code-model-picker";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { launchNativeFixture } from "./launch-native-fixture";

test("Code keeps the conversation and composer reachable when drafts and zoom change", {
  timeout: 150_000,
  skip: !!process.env.TOMVERSE_DESKTOP_TASK_QA_EXECUTABLE,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tomverse-desktop-code-layout-"));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  const references = Array.from({ length: 10 }, (_, index) => join(root, `search-regression-reference-document-${index + 1}.txt`));
  const title = "Review the search result transitions";
  const ending = "End of the verified search summary.";
  const response = [...Array.from({ length: 45 }, (_, index) =>
    `Reference ${index + 1}: the latest search response is checked against its active request.`), ending].join("\n\n");
  let finish!: () => void;
  const waitForDraft = new Promise<void>((resolve) => { finish = resolve; });
  const gateway = await new FakeGateway({ async script(_request, index) {
    if (index === 0) return { toolCalls: [{ name: "update_task_plan", args: {
      revision: 0, items: [{ id: "inspect", title: "Inspect search results" }], activeId: "inspect", analysis: fixtureWorkAnalysis,
    } }] };
    await waitForDraft;
    return { text: response };
  } }).start();
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await Promise.all([writeFile(join(profile, "language.txt"), "en"), ...references.map((file) => writeFile(file, "Search result evidence."))]);
    const descriptor = join(directory, "fixture.json");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const size = (width: number, height: number, zoom: number) => app!.evaluate(({ BrowserWindow }, next) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setSize(next.width, next.height);
      window.webContents.setZoomFactor(next.zoom);
    }, { width, height, zoom });
    async function paint() {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    async function measure() {
      await paint();
      return page.evaluate((endingText) => {
        const pane = document.querySelector<HTMLElement>(".work .scroll")!;
        const composer = document.querySelector<HTMLElement>(".composer-slot .composer")!;
        const actions = composer.querySelector<HTMLElement>(".composer-actions")!;
        const slot = composer.parentElement!;
        const footer = pane.querySelector<HTMLElement>(".task-status");
        const rail = document.querySelector<HTMLElement>(".rail")!;
        const paneBounds = pane.getBoundingClientRect();
        const footerBounds = footer?.getBoundingClientRect();
        const actionBounds = actions.getBoundingClientRect();
        const answer = [...pane.querySelectorAll(".entry--assistant [role='group']")].at(-1)?.firstChild;
        const range = document.createRange();
        if (answer instanceof Text) {
          const start = answer.data.lastIndexOf(endingText);
          if (start >= 0) {
            range.setStart(answer, start);
            range.setEnd(answer, start + endingText.length);
          }
        }
        const endBounds = range.getBoundingClientRect();
        return {
          height: Math.round(composer.getBoundingClientRect().height),
          gutter: getComputedStyle(pane.firstElementChild!).paddingInlineStart,
          rail: getComputedStyle(rail).backgroundColor,
          top: pane.scrollTop,
          body: pane.clientHeight,
          tail: Math.round(pane.scrollHeight - pane.scrollTop - pane.clientHeight),
          answerVisible: endBounds.height > 0 && endBounds.top >= paneBounds.top - 1 && endBounds.bottom <= paneBounds.bottom + 1,
          footerVisible: !!footerBounds && footerBounds.bottom <= paneBounds.bottom + 1 && footerBounds.bottom > paneBounds.top,
          bottom: Math.round(slot.getBoundingClientRect().bottom),
          actionsVisible: actionBounds.top >= paneBounds.bottom - 1 && actionBounds.bottom <= innerHeight,
          viewport: innerHeight,
        };
      }, ending);
    }
    async function capture(name: string) {
      const artifacts = process.env.TOMVERSE_DESKTOP_CODE_LAYOUT_QA;
      if (!artifacts || !app) return;
      await paint();
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
      await writeFile(join(artifacts, name), Buffer.from(png, "base64"));
    }

    await size(1440, 960, 1);
    await page.getByRole("button", { name: "Open local folder", exact: true }).click();
    const field = page.getByRole("textbox", { name: "Code request", exact: true });
    const ready = page.getByRole("button", { name: "Send Code request", exact: true });
    assert.deepEqual(await page.getByRole("navigation", { name: "Workspaces" }).locator(".rail-tools button, .rail-settings").allTextContents(),
      ["Chat", "Review", "Code", "Plugins", "Settings"]);
    await expect(page.getByRole("form")).toHaveCount(1);
    await expect(page.getByRole("form", { name: "Code composer" })).toBeVisible();
    await expect(codeModelControl(page)).toBeVisible();
    const initial = await measure();
    await field.fill(title);
    await ready.click();
    await expect(page.getByRole("button", { name: "Stop Code task" })).toBeVisible();
    await expect(page.locator(".header strong")).toHaveText(title);
    await expect(page.getByText("Inspect search results", { exact: true })).toBeVisible();
    const running = await measure();
    await capture("running-dark.png");
    await page.getByRole("button", { name: "Use light theme" }).click();
    const light = await measure();
    await capture("running-light.png");
    finish();
    await expect(page.getByText(ending, { exact: false }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Code task" })).toHaveCount(0);
    await expect(page.locator(".projects").getByRole("button", { name: title, exact: true })).toHaveCSS("height", "32px");
    const completed = await measure();

    const draft = Array.from({ length: 9 }, (_, index) => `Follow-up detail ${index + 1}`).join("\n");
    await field.fill(draft);
    const taller = await measure();
    const pane = page.locator(".work .scroll");
    await pane.evaluate((element) => { element.scrollTop = 160; });
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(160);
    await paint();
    await field.fill("Keep reading the earlier response");
    const reading = await measure();
    await size(1180, 780, 1);
    const separator = page.getByRole("separator", { name: "Resize history" });
    for (let step = 0; step < 9; step++) await separator.press("ArrowRight");
    const narrow = await measure();
    await pane.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await paint();

    await app.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
    }, references);
    await page.getByLabel("Attach project files or folders").click();
    await page.getByRole("button", { name: "Attach files", exact: true }).click();
    const chips = page.getByRole("list", { name: "Project references", exact: true });
    await expect(chips.getByRole("listitem")).toHaveCount(10);
    const attached = await measure();
    await size(690, 560, 2);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(400);
    await field.fill(draft);
    const compact = await measure();
    await capture("attached-light-200-percent.png");
    await page.getByRole("button", { name: "Use dark theme" }).click();
    const compactDark = await measure();
    await capture("attached-dark-200-percent.png");
    await expect(field).toHaveValue(draft);
    const lastReference = chips.getByRole("button", { name: "Remove search-regression-reference-document-10.txt" });
    await lastReference.focus();
    await expect(lastReference).toBeInViewport();
    await expect(ready).toBeInViewport({ ratio: 1 });
    await lastReference.press("Enter");
    await expect(chips.getByRole("listitem")).toHaveCount(9);
    await field.focus();
    await expect(field).toBeInViewport();
    assert.equal(gateway.completions.length, 2);
    assert.deepEqual({
      design: [initial.height, initial.gutter, initial.rail, light.rail],
      running: running.actionsVisible && running.bottom === running.viewport && light.bottom === light.viewport,
      completed: completed.tail <= 1 && completed.footerVisible && completed.answerVisible,
      expanded: taller.height > completed.height && taller.tail <= 1 && taller.footerVisible && taller.answerVisible,
      earlier: reading.top === 160 && reading.bottom === reading.viewport,
      narrow: narrow.gutter === "23px" && narrow.actionsVisible && narrow.bottom === narrow.viewport,
      compact: [compact, compactDark].every((layout) => layout.body >= 20 && layout.tail <= 1 &&
        layout.footerVisible && layout.actionsVisible && Math.abs(layout.bottom - layout.viewport) <= 1),
    }, { design: [112, "48px", "rgb(10, 16, 32)", "rgb(10, 16, 32)"], running: true, completed: true, expanded: true, earlier: true, narrow: true, compact: true },
    JSON.stringify({ initial, running, light, completed, taller, reading, narrow, attached, compact, compactDark }));
  } finally {
    finish();
    await app?.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
