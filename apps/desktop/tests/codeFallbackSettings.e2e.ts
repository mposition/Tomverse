import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktop = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("Code saves fallback settings in the selected connection scope and can revoke them without model requests", { timeout: 75_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-code-fallback-settings-"));
  const root = join(temp, "project");
  const profile = join(temp, "profile");
  const descriptor = join(temp, "fixture.json");
  const endpoint = new FakeGateway({ script: () => ({ text: "Unexpected fallback request" }) });
  const otherEndpoint = new FakeGateway({ script: () => ({ text: "Unexpected fallback request" }) });
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), endpoint.start(), otherEndpoint.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    async function launch(gateway: FakeGateway) {
      await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, claude: {
        executable: join(temp, "unused-claude.exe"), version: "2.1.278", model: "fixture-claude", origin: `http://127.0.0.1:${gateway.port}`,
      } }));
      return electron.launch({ executablePath, args: [desktop, "--desktop-fixture", descriptor], timeout: 25_000 });
    }
    app = await launch(endpoint);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    const state = () => page.evaluate(() => window.desktop.state());
    const scope = (await state()).codeFallback?.scope;
    assert.ok(scope);
    const automatic = page.getByLabel("Switch automatically when limits are reached");
    const destination = page.getByLabel("Fallback destination");
    const preferred = page.getByLabel("Preferred execution mode");
    const model = page.getByLabel("Fallback model");
    const review = page.getByRole("main").getByRole("button", { name: "Review", exact: true });
    await expect(automatic).toHaveValue("off");
    await expect(automatic).toBeDisabled();
    await expect(destination).toHaveValue("");
    await assert.rejects(page.evaluate((scope) => window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true }), scope), /fallback model/);
    await destination.selectOption("anthropic");
    await model.selectOption("fixture-claude");
    await page.getByLabel("API task limit").fill("100");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await automatic.selectOption("on");
    await expect(page.getByText("Preference saved. Switching requires verified limits and billing.", { exact: true })).toBeVisible();
    await review.click();
    await page.getByRole("radio", { name: "Send the task summary and file changes needed to continue", exact: true }).check();
    await expect(automatic).toHaveValue("off");
    await automatic.selectOption("on");
    await review.click();
    await expect(automatic).toHaveValue("on");
    const saved = (await state()).codeFallback;
    assert.deepEqual(saved?.settings, { version: 1, destination: { executionMode: "provider_cli", provider: "anthropic",
      model: "fixture-claude", version: "2.1.278" }, apiCreditCap: 100, transfer: "summary_and_changes", automaticFrom: "tomverse_api" });

    const artifact = process.env.TOMVERSE_CODE_FALLBACK_QA;
    if (artifact) {
      const settings = page.locator(".execution-settings");
      await settings.screenshot({ path: join(artifact, "execution-settings-dark.png") });
      await page.getByRole("button", { name: "Use light theme" }).click();
      await settings.screenshot({ path: join(artifact, "execution-settings-light.png") });
    }
    await preferred.selectOption("provider_cli");
    await expect(automatic).toHaveValue("off");
    await destination.selectOption("tomverse_api");
    await expect(model.locator('option[value="fake-coder"]')).toHaveCount(1);
    await expect(model.locator('option[value="smart-adaptive"]')).toHaveCount(0);
    await model.selectOption("fake-coder");
    await automatic.selectOption("on");
    const alternate = (await state()).codeFallback;
    assert.equal(alternate?.settings.automaticFrom, "provider_cli");

    await app.close();
    app = await launch(otherEndpoint);
    const other = await app.firstWindow();
    await other.getByRole("button", { name: "Desktop settings" }).click();
    await other.getByRole("button", { name: "Execution and limits", exact: true }).click();
    const isolated = await other.evaluate(() => window.desktop.state()).then((snapshot) => snapshot.codeFallback);
    assert.notEqual(isolated?.scope, scope);
    assert.equal(isolated?.settings.automaticFrom, null);
    assert.equal(isolated?.settings.apiCreditCap, null);
    await assert.rejects(other.evaluate((scope) => window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 500 }), scope),
      /settings account changed/);
    await app.close();
    app = await launch(endpoint);
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: "Desktop settings" }).click();
    await reopened.getByRole("button", { name: "Execution and limits", exact: true }).click();
    assert.deepEqual(await reopened.evaluate(() => window.desktop.state()).then((snapshot) => snapshot.codeFallback), alternate);
    await reopened.getByLabel("Switch automatically when limits are reached").selectOption("off");
    await expect(reopened.getByLabel("Switch automatically when limits are reached")).toHaveValue("off");
    assert.equal(endpoint.completions.length, 0);
    assert.equal(otherEndpoint.completions.length, 0);
  } finally {
    if (app) await app.close();
    await Promise.all([endpoint.stop(), otherEndpoint.stop()]);
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
