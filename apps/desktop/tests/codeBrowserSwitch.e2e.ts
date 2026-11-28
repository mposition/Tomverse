import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const electronPath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

async function listen(server: Server) {
  await new Promise<void>((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return "http://127.0.0.1:" + address.port;
}

type Names = string[];
const toolNames = (body: { tools?: Array<{ function: { name: string } }> }): Names => (body.tools ?? []).map((tool) => tool.function.name);

test("the browser panel needs no fixture flag, the agent's browser tools are the person's switch (off until turned on), and a task that resumes gets them", { timeout: 120_000 }, async () => {
  const site = createServer((_request, reply) => {
    reply.setHeader("Content-Type", "text/html; charset=utf-8");
    reply.end("<title>Switch fixture</title><h1>Hello from the dev server</h1><button id='go'>Go</button>");
  });
  const origin = await listen(site);
  const href = origin + "/";
  const question = "Which page should I look at?";
  const seen: Names[] = [];
  const gateway = await new FakeGateway({
    script(body, index) {
      seen.push(toolNames(body as { tools?: Array<{ function: { name: string } }> }));
      if (index === 0) return { toolCalls: [{ name: "update_task_plan", args: { revision: 0, items: [], activeId: null, analysis: fixtureWorkAnalysis, clarification: question } }] };
      if (index === 1) return { toolCalls: [{ name: "browser_navigate", args: { url: href } }] };
      if (index === 2) return { toolCalls: [{ name: "browser_read", args: {} }] };
      return { text: "I saw the page." };
    },
  }).start();
  const directory = await mkdtemp(join(tmpdir(), "tomverse-desktop-browser-switch-"));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(profile, "language.txt"), "en");
  // No browserAgent and no browserInspection: nothing in the fixture turns the browser on.
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({ executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByLabel("Code mode").selectOption("agent");

    // The panel is there and shows a local page, with the agent's tools still off.
    assert.equal((await page.evaluate(() => window.desktop.state())).codeBrowserAgent, false);
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Browser", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByLabel("Address").fill(href);
    await panel.getByLabel("Address").press("Enter");
    await expect.poll(() => app.context().pages().some((candidate) => candidate.url() === href)).toBe(true);
    await expect(panel.getByRole("button", { name: "Select element", exact: true })).toBeEnabled({ timeout: 15_000 });

    // The first request of a task has no browser tool.
    const composer = page.getByRole("textbox", { name: "Code request" });
    await composer.fill("Look at my page.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).task?.status).toBe("clarification");
    assert.ok(seen[0]!.length > 0 && seen[0]!.every((name) => !name.startsWith("browser_")), "off by default: " + seen[0]!.join());

    // The switch is in Settings; turning it on needs no restart and writes one small file of its own.
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    const setting = page.getByTestId("code-browser-agent-setting");
    await expect(setting.getByLabel("Let Code use the browser panel")).toHaveValue("off");
    await setting.getByLabel("Let Code use the browser panel").selectOption("on");
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).codeBrowserAgent).toBe(true);
    // Public sites are a second switch under it, off by default, writing a file of its own.
    const web = page.getByTestId("code-browser-web-setting").getByLabel("Let Code open public websites in the browser panel");
    await expect(web).toHaveValue("off");
    assert.equal((await page.evaluate(() => window.desktop.state())).codeBrowserWeb, false);
    await web.selectOption("on");
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).codeBrowserWeb).toBe(true);
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    assert.equal(await readFile(join(userData, "code-browser-agent.txt"), "utf8"), "enabled");
    assert.equal(await readFile(join(userData, "code-browser-web.txt"), "utf8"), "enabled");
    await web.selectOption("off");
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).codeBrowserWeb).toBe(false);
    assert.equal(await readFile(join(userData, "code-browser-web.txt"), "utf8"), "disabled");
    await page.getByRole("button", { name: "Code", exact: true }).click();

    // The task answers its question and resumes: the resumed run has the browser tools the switch now gives.
    await composer.fill("The home page of my dev server.");
    await page.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect(page.getByText("I saw the page.", { exact: true })).toBeVisible({ timeout: 30_000 });
    assert.ok(seen[1]!.includes("browser_navigate") && seen[1]!.includes("browser_read"), "resumed with the tools: " + seen[1]!.join());
    const outputs = (gateway.completions.at(-1)!.body.messages as Array<{ role: string; content: unknown }>).filter(({ role }) => role === "tool")
      .map(({ content }) => JSON.stringify(content)).join("\n");
    assert.match(outputs, /Hello from the dev server/, "the agent read the page of the panel");

    // Turning it off again takes the tools away from the next task.
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await page.getByTestId("code-browser-agent-setting").getByLabel("Let Code use the browser panel").selectOption("off");
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).codeBrowserAgent).toBe(false);
    assert.equal(await readFile(join(userData, "code-browser-agent.txt"), "utf8"), "disabled");
  } finally {
    await app.close();
    site.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
