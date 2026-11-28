import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import { chooseCodeModel, codeModelControl, codeModelPicker } from "./code-model-picker";
import { DEFAULT_MODELS, FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("Code saves its execution preference and only sends requests through the shown route", { timeout: 60_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-desktop-execution-"));
  const root = join(tmp, "project");
  const profile = join(tmp, "profile");
  const descriptor = join(tmp, "fixture.json");
  const providerModel = { ...DEFAULT_MODELS[0], id: "api-only", tomverse: { ...DEFAULT_MODELS[0]!.tomverse, name: "API-only fixture", provider: "groq" } };
  const imageModel = { ...DEFAULT_MODELS[0], id: "image-only", tomverse: { ...DEFAULT_MODELS[0]!.tomverse, provider: "bfl", protocols: ["images"] } };
  const catalog: Array<Record<string, unknown>> = [];
  const gateway = new FakeGateway({ models: catalog, script: () => ({ text: "Route verified." }) });
  gateway.revoked = true;
  let app: ElectronApplication | undefined;
  const launch = () => electron.launch({ executablePath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await gateway.start();
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launch();
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    const send = page.getByRole("button", { name: "Send Code request" });
    const request = page.getByRole("textbox", { name: "Code request", exact: true });
    const settings = async () => {
      await page.getByRole("button", { name: "Desktop settings" }).click();
      await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    };
    const preference = page.getByLabel("Preferred execution mode");
    const reload = page.getByRole("button", { name: "Reload Code models" });
    await expect(request).toHaveAccessibleDescription(/Code models could not load/);
    await request.fill("Check the selected route");
    await expect(send).toBeDisabled();
    const appWindow = await app.browserWindow(page);
    const bounds = await appWindow.evaluate((current) => {
      const original = current.getBounds();
      current.setSize(690, 560);
      current.webContents.setZoomFactor(2);
      return original;
    });
    await expect(reload).toBeInViewport({ ratio: 1 });
    await expect(send).toBeInViewport({ ratio: 1 });
    await appWindow.evaluate((current, original) => {
      current.webContents.setZoomFactor(1);
      current.setBounds(original);
    }, bounds);
    gateway.revoked = false;
    await reload.press("Enter");
    await expect(request).toBeFocused();
    await expect(request).toHaveAccessibleDescription("No connected models");
    await expect(send).toBeDisabled();
    catalog.push(...DEFAULT_MODELS, providerModel, imageModel);
    await reload.press("Enter");
    await expect(request).toHaveAccessibleDescription("Open a project folder to send a Code request.");
    await expect(send).toBeDisabled();
    assert.equal(gateway.requests.filter(({ url }) => url === "/api/code/v1/models").length, 3);
    assert.equal(gateway.completions.length, 0);

    await page.getByRole("button", { name: "Show history", exact: true }).click();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await expect(page.getByText("No saved tasks in this project yet.")).toBeVisible();
    await settings();
    await expect(preference).toHaveValue("tomverse_api");
    await preference.selectOption("provider_cli");
    await expect.poll(async () => (await state()).codeExecutionPreference).toBe("provider_cli");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await request.fill("Check the selected route");
    await expect(page.getByText("Choose Tomverse API to use this model.")).toBeVisible();
    await expect(send).toBeDisabled();
    await codeModelControl(page).click();
    await expect(codeModelPicker(page).locator('[data-model-id="fake-coder"]')).toBeVisible();
    await expect(codeModelPicker(page).locator('[data-model-id="image-only"]')).toHaveCount(0);
    await codeModelPicker(page).getByTestId("model-picker-done").click();
    await chooseCodeModel(page, { model: "fake-coder" });
    const codexSupported = (await state()).supportedCliPaths.includes("openai");
    await expect(page.getByText(codexSupported ? "Codex · Commercial integration approval required" : "Codex · Unsupported on this platform")).toBeVisible();
    await expect(send).toBeDisabled();
    await assert.rejects(page.evaluate(() => window.desktop.start({ prompt: "Bypass UI", model: "fake-coder", mode: "ask", effort: "default",
      executionMode: "tomverse_api" })), /execution route is unavailable/);
    assert.equal(gateway.completions.length, 0);

    await page.getByRole("button", { name: "Use Tomverse API", exact: true }).press("Enter");
    await expect(request).toBeFocused();
    await expect(request).toHaveValue("Check the selected route");
    await expect(send).toBeEnabled();
    await expect.poll(async () => (await state()).codeExecutionPreference).toBe("tomverse_api");
    assert.equal(gateway.completions.length, 0);
    await settings();
    await preference.selectOption("provider_cli");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await chooseCodeModel(page, { model: "api-only" });
    await expect(page.getByRole("status").filter({ hasText: /^Tomverse API$/ })).toBeVisible();
    await page.getByLabel("Code mode").selectOption("ask");
    await send.click();
    await expect(page.getByText("Route verified.", { exact: true })).toBeVisible();
    await expect.poll(async () => (await state()).task?.status).toBe("completed");
    assert.deepEqual(gateway.completions.map(({ body }) => body.model), ["api-only"]);
    assert.deepEqual((await state()).task?.execution, { executionMode: "tomverse_api", billingSource: "tomverse_credits" });

    const search = page.getByRole("button", { name: "Search history" });
    const filter = page.getByRole("textbox", { name: "Filter task history" });
    const savedTask = page.getByRole("button", { name: "Check the selected route", exact: true });
    await search.press("Enter");
    await expect(filter).toBeFocused();
    await filter.fill("no matching task");
    await expect(savedTask).toHaveCount(0);
    await expect(page.getByText("No matches in loaded task history.")).toBeVisible();
    await filter.press("Escape");
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute("aria-expanded", "false");
    await expect(savedTask).toBeVisible();
    await search.press("Enter");
    await expect(filter).toHaveValue("");
    await filter.press("Escape");

    providerModel.tomverse.provider = "openai";
    await request.fill("Check a changed catalog provider");
    await send.click();
    await expect.poll(async () => {
      const task = (await state()).task;
      return task?.title === "Check a changed catalog provider" && task.status;
    }).toBe("failed");
    assert.equal(gateway.completions.length, 1);
    assert.equal((await state()).task?.execution, undefined);

    await settings();
    await preference.selectOption("tomverse_api");
    await expect.poll(async () => (await state()).codeExecutionPreference).toBe("tomverse_api");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await chooseCodeModel(page, { model: "fake-coder" });
    await request.fill("Use the vendor model through the API");
    await send.click();
    await expect.poll(async () => (await state()).task?.status).toBe("completed");
    assert.deepEqual(gateway.completions.map(({ body }) => body.model), ["api-only", "fake-coder"]);

    await settings();
    await preference.selectOption("provider_cli");
    await expect.poll(async () => (await state()).codeExecutionPreference).toBe("provider_cli");
    await app.close();
    app = await launch();
    const restarted = await app.firstWindow();
    await restarted.getByRole("button", { name: "Desktop settings" }).click();
    await restarted.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await expect(restarted.getByLabel("Preferred execution mode")).toHaveValue("provider_cli");
  } finally {
    await app?.close();
    await gateway.stop();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
