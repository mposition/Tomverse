import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { DEFAULT_MODELS, FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

/** The fixture runs the computer tools against a fake desktop (two windows and a picture): no real window is touched. */
async function launch(gateway: FakeGateway) {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-computer-use-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, computerUse: true }));
  const app = await launchNativeFixture(descriptor);
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Open local folder" }).click();
  await page.getByLabel("Code mode").selectOption("agent");
  return { folder, app, page };
}

async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

async function approvalWindow(app: ElectronApplication, heading: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    for (const candidate of app.windows()) {
      if (candidate.isClosed()) continue;
      try { if (await candidate.getByRole("heading", { name: heading }).count()) return candidate; } catch { /* The window is closing. */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("No approval window for " + heading);
}

const seeingModels = DEFAULT_MODELS.map((model) => {
  const entry = model as { tomverse: { capabilities: object } };
  return { ...entry, tomverse: { ...entry.tomverse, capabilities: { ...entry.tomverse.capabilities, vision: true } } };
});
const toolOutputs = (gateway: FakeGateway) => (gateway.completions.at(-1)!.body.messages as Array<{ role: string; content: unknown }>)
  .filter(({ role }) => role === "tool").map(({ content }) => JSON.stringify(content));

test("the person chooses one window, the agent looks at it, and a click asks first and is done only after the approval", { timeout: 120_000 }, async () => {
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body).length;
      if (results === 0) return { toolCalls: [{ name: "computer_screenshot", args: {} }] };
      if (results === 1) return { toolCalls: [{ name: "computer_click", args: { x: 100, y: 60 } }] };
      if (results === 2) return { toolCalls: [{ name: "computer_key", args: { key: "Alt+F4" } }] };
      return { text: "The calculator button was pressed." };
    },
    models: seeingModels,
  }).start();
  let app: ElectronApplication | undefined;
  let folder = "";
  try {
    ({ app, folder } = await launch(gateway));
    const page = await app.firstWindow();
    // The panel offers only windows that may be chosen: the fixture's second window is a browser and is kept back.
    const panel = page.getByTestId("code-computer");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Choose window", exact: true }).click();
    const rows = panel.getByTestId("code-computer-window");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Fixture calculator");
    await expect(panel.getByText("1 other windows are not offered.")).toBeVisible();
    await rows.first().click();
    await expect(page.getByTestId("code-computer-selected")).toContainText("Fixture calculator (fixture-calc)");
    await expect(panel.getByRole("button", { name: "Take control", exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "Code request" }).fill("Press the calculator's button.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    // Looking needed no question: the first card is the click's, with the window, the program and the point.
    const approval = await approvalWindow(app, "Click in a desktop window");
    await expect(approval.getByText("Fixture calculator", { exact: true })).toBeVisible();
    await expect(approval.getByText("fixture-calc", { exact: true })).toBeVisible();
    await expect(approval.getByText("100, 60", { exact: true })).toBeVisible();
    await expect(approval.getByRole("button", { name: "Allow for this run", exact: true })).toBeVisible();
    await press(approval, "Allow once");
    await expect(page.getByText("The calculator button was pressed.", { exact: true })).toBeVisible({ timeout: 30_000 });

    const outputs = toolOutputs(gateway).join("\n");
    assert.match(outputs, /Fixture calculator/);
    assert.match(outputs, /untrusted data from another program/);
    assert.match(outputs, /Take a screenshot to see the result/, "the approved click was done");
    assert.match(outputs, /That key is not allowed/, "a key outside the list is refused before anyone is asked");
    assert.match(JSON.stringify(gateway.completions.map(({ body }) => body.messages)), /data:image\/png;base64,/, "the picture reached the model");
  } finally {
    await app?.close();
    await gateway.stop();
    if (folder) await removeNativeFixtureDirectory(folder);
  }
});
