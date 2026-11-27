import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { DEFAULT_MODELS, FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const PAGE = "<title>Agent fixture</title><h1>Counter fixture</h1><p id='out'>Count: 0</p>" +
  "<button id='add' onclick=\"n++;out.textContent='Count: '+n\">Add item</button><label>Name <input id='name'></label>" +
  "<label>Secret <input id='secret' type='password'></label><script>let n=0;console.error('fixture console error');</script>";

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return "http://127.0.0.1:" + address.port;
}

async function launch(gateway: FakeGateway, options: { browserAgent?: boolean; agentMode?: boolean } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-browser-agent-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, ...(options.browserAgent === false ? {} : { browserAgent: true }) }));
  const app = await launchNativeFixture(descriptor);
  const page = await app.firstWindow();
  await openCodeProject(page);
  if (options.agentMode !== false) await selectCodeMode(page, "agent");
  return { folder, app, page };
}

/** The approval window closes as the click lands, so a closed page after the click is the expected end. */
async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

/** The approval is a window of its own; the browser tabs of the panel are pages of the same application, so look for the card itself. */
async function approvalWindow(app: ElectronApplication, heading: string, detail?: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    for (const candidate of app.windows()) {
      if (candidate.isClosed()) continue;
      try {
        if (await candidate.getByRole("heading", { name: heading }).count() && (!detail || await candidate.getByText(detail, { exact: true }).count())) return candidate;
      } catch { /* The window is closing. */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("No approval window for " + heading);
}

/** Every model of the fixture can see images, so the screenshot tool is offered whichever one the panel picks. */
const seeingModels = DEFAULT_MODELS.map((model) => {
  const entry = model as { tomverse: { capabilities: object } };
  return { ...entry, tomverse: { ...entry.tomverse, capabilities: { ...entry.tomverse.capabilities, vision: true } } };
});

const toolOutputs = (gateway: FakeGateway) => (gateway.completions.at(-1)!.body.messages as Array<{ role: string; content: unknown }>)
  .filter(({ role }) => role === "tool").map(({ content }) => JSON.stringify(content));

test("the agent opens a local page, reads it, clicks after approval and reads the changed text; the person's element comment reaches the composer", { timeout: 120_000 }, async () => {
  const site = createServer((_request, reply) => { reply.setHeader("Content-Type", "text/html; charset=utf-8"); reply.end(PAGE); });
  const origin = await listen(site);
  const href = origin + "/";
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body).length;
      if (results === 0) return { toolCalls: [{ name: "browser_navigate", args: { url: href } }] };
      if (results === 1) return { toolCalls: [{ name: "browser_read", args: {} }] };
      if (results === 2) return { toolCalls: [{ name: "browser_click", args: { selector: "#add" } }] };
      if (results === 3) return { toolCalls: [{ name: "browser_read", args: {} }] };
      if (results === 4) return { toolCalls: [{ name: "browser_type", args: { selector: "#name", text: "Ada" } }] };
      if (results === 5) return { toolCalls: [{ name: "browser_type", args: { selector: "#secret", text: "hunter2" } }] };
      if (results === 6) return { toolCalls: [{ name: "browser_console", args: {} }] };
      if (results === 7) return { toolCalls: [{ name: "browser_screenshot", args: { selector: "#add" } }] };
      return { text: "The counter went up." };
    },
    models: seeingModels,
  }).start();
  let app: ElectronApplication | undefined;
  let folder = "";
  try {
    ({ app, folder } = await launch(gateway));
    const page = (await app.firstWindow());
    await page.getByRole("textbox", { name: "Code request" }).fill("Press Add item on my page and tell me the counter.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    // Reading needed no question: the first card to ask is the click's.
    const approval = await approvalWindow(app, "Click in the browser tab");
    await expect(approval.getByText(origin, { exact: true })).toBeVisible();
    await expect(approval.getByText("#add", { exact: true })).toBeVisible();
    await expect(approval.getByRole("button", { name: "Allow for this run", exact: true })).toBeVisible();
    // The panel opened by itself and says the agent holds the tab.
    await expect(page.getByRole("complementary", { name: "Browser" })).toBeVisible();
    await expect(page.getByText("The agent is using this tab.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
    await press(approval, "Allow once");
    // Typing is asked about too, with the exact text; a password field is refused by the host even when the person allowed it.
    const typing = await approvalWindow(app, "Type in the browser tab", "Ada");
    await expect(typing.getByText("#name", { exact: true })).toBeVisible();
    await press(typing, "Allow once");
    const secret = await approvalWindow(app, "Type in the browser tab", "hunter2");
    await press(secret, "Allow once");
    await expect(page.getByText("The counter went up.", { exact: true })).toBeVisible({ timeout: 30_000 });

    const outputs = toolOutputs(gateway);
    assert.match(outputs.join("\n"), /Count: 0/);
    assert.match(outputs.join("\n"), /Count: 1/, "the second read shows the text the click changed");
    assert.match(outputs.join("\n"), /Untrusted web page content/);
    assert.match(outputs.join("\n"), /button.*Add item.*#add/s, "the read lists the control with a selector");
    assert.match(outputs.join("\n"), /fixture console error/);
    assert.match(outputs.join("\n"), /never typed by the agent/);
    assert.match(JSON.stringify(gateway.completions.at(-1)!.body.messages), /data:image\/png;base64,/, "the screenshot reached the model as an image");
    const inspected = app.context().pages().find((candidate) => candidate.url() === href);
    assert.ok(inspected);
    await expect(inspected.locator("#name")).toHaveValue("Ada");
    await expect(inspected.locator("#secret")).toHaveValue("");

    // The person points at an element and comments on it; the comment goes into the composer.
    const panel = app.context().pages().find((candidate) => candidate.url() === href);
    assert.ok(panel, "the agent's tab is a real page of the panel");
    await page.getByRole("button", { name: "Select element", exact: true }).click();
    await expect(page.getByText("Click an element in the page to comment on it.")).toBeVisible();
    await panel.locator("#add").click();
    const comments = page.getByRole("region", { name: "Element comments" });
    await expect(comments).toBeVisible({ timeout: 10_000 });
    await expect(comments.getByText("#add", { exact: true })).toBeVisible();
    await expect(comments.getByRole("img", { name: "The selected element" })).toBeVisible();
    await comments.getByRole("textbox").fill("Make this button blue.");
    await comments.getByRole("button", { name: "Add to message (1)" }).click();
    const composer = page.getByRole("textbox", { name: "Code request" });
    await expect(composer).toHaveValue(/selector "#add"/);
    const draft = await composer.inputValue();
    assert.match(draft, /text "Add item"/);
    assert.match(draft, /picture pick-[0-9a-f]{8} \(attached as an image when the model can see images; browser_screenshot with pick/);
    assert.match(draft, /comment: Make this button blue\./);
    await expect(comments).toBeHidden();
  } finally {
    await app?.close();
    site.close();
    await gateway.stop();
    if (folder) await removeNativeFixtureDirectory(folder);
  }
});

test("the person takes the tab back from the agent: its next request is refused, and the person can hand it back", { timeout: 120_000 }, async () => {
  const site = createServer((_request, reply) => { reply.setHeader("Content-Type", "text/html; charset=utf-8"); reply.end(PAGE); });
  const origin = await listen(site);
  const href = origin + "/";
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gateway = await new FakeGateway({
    async script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body).length;
      if (results === 0) return { toolCalls: [{ name: "browser_navigate", args: { url: "https://example.com/" } }] };
      if (results === 1) return { toolCalls: [{ name: "browser_navigate", args: { url: href } }] };
      if (results === 2) { await held; return { toolCalls: [{ name: "browser_read", args: {} }] }; }
      return { text: "The browser was taken back." };
    },
  }).start();
  let app: ElectronApplication | undefined;
  let folder = "";
  try {
    ({ app, folder } = await launch(gateway));
    const page = await app.firstWindow();
    await page.getByRole("textbox", { name: "Code request" }).fill("Open my page and read it.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect(page.getByText("The agent is using this tab.")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.getByText("You took this tab from the agent.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Let the agent continue" })).toBeVisible();
    release();
    await expect(page.getByText("The browser was taken back.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const outputs = toolOutputs(gateway).join("\n");
    assert.match(outputs, /Only an http address on localhost, 127\.0\.0\.1 or \[::1\] with a port can be opened/, "an outside address is refused");
    assert.match(outputs, /The user took control of the browser/);
    assert.doesNotMatch(outputs, /Count: 0/, "nothing was read after the person took the tab");
  } finally {
    release();
    await app?.close();
    site.close();
    await gateway.stop();
    if (folder) await removeNativeFixtureDirectory(folder);
  }
});

/** The person opens a page in the panel and picks two elements: a button, and a password field that must not be photographed. */
async function pickElements(app: ElectronApplication, page: Page, href: string) {
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  const address = page.getByRole("textbox", { name: "Address" });
  await address.fill(href);
  await address.press("Enter");
  let panel: Page | undefined;
  await expect.poll(() => { panel = app.context().pages().find((candidate) => candidate.url() === href); return Boolean(panel); }).toBe(true);
  const comments = page.getByRole("region", { name: "Element comments" });
  await expect(page.getByRole("button", { name: "Select element", exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Select element", exact: true }).click();
  await expect(page.getByText("Click an element in the page to comment on it.")).toBeVisible();
  await panel!.locator("#add").click();
  await expect(comments.getByText("#add", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(comments.getByRole("img", { name: "The selected element" })).toHaveCount(1);
  await comments.getByRole("textbox").first().fill("Make this button blue.");
  return { panel: panel!, comments };
}

const imageParts = (gateway: FakeGateway) => (gateway.completions[0]!.body.messages as Array<{ role: string; content: unknown }>)
  .flatMap(({ content }) => Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "image_url") : []);

test("the picture of a picked element goes to a model that sees images with the instruction; a secret field is never photographed", { timeout: 120_000 }, async () => {
  const site = createServer((_request, reply) => { reply.setHeader("Content-Type", "text/html; charset=utf-8"); reply.end(PAGE); });
  const href = (await listen(site)) + "/";
  const gateway = await new FakeGateway({ script: () => ({ text: "I can see the button." }), models: seeingModels }).start();
  let app: ElectronApplication | undefined;
  let folder = "";
  try {
    ({ app, folder } = await launch(gateway, { browserAgent: false, agentMode: false }));
    const page = await app.firstWindow();
    const { panel, comments } = await pickElements(app, page, href);
    await page.getByRole("button", { name: "Select element", exact: true }).click();
    await panel.locator("#secret").click();
    await expect(comments.getByText("No picture is sent: this element holds a secret field.")).toBeVisible({ timeout: 10_000 });
    await expect(comments.getByRole("img", { name: "The selected element" }), "only the button has a picture").toHaveCount(1);
    await comments.getByRole("button", { name: "Add to message (2)" }).click();
    const composer = page.getByRole("textbox", { name: "Code request" });
    const draft = await composer.inputValue();
    assert.match(draft, /picture pick-[0-9a-f]{8} \(attached as an image when the model can see images\)/);
    assert.doesNotMatch(draft, /browser_screenshot/, "the agent has no browser tools here");
    assert.match(draft, /picture withheld \(the element holds a secret field\)/);
    assert.equal((draft.match(/attached as an image/g) ?? []).length, 1, "only the button's picture is carried");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect(page.getByText("I can see the button.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const messages = gateway.completions[0]!.body.messages as Array<{ role: string; content: unknown }>;
    const instruction = messages.findIndex(({ role, content }) => role === "user" && typeof content === "string" && content.includes("Make this button blue."));
    assert.ok(instruction > 0, "the instruction reached the model as text");
    const pictures = imageParts(gateway) as Array<{ image_url: { url: string } }>;
    assert.equal(pictures.length, 1, "one picture: the button");
    assert.match(pictures[0]!.image_url.url, /^data:image\/(png|jpeg);base64,/);
    assert.ok(pictures[0]!.image_url.url.length > 100, "a real picture, not an empty one");
    assert.ok(Array.isArray(messages[instruction + 1]!.content), "the picture follows the instruction");
  } finally {
    await app?.close();
    site.close();
    await gateway.stop();
    if (folder) await removeNativeFixtureDirectory(folder);
  }
});

test("a model that cannot see images gets the picked element's text only", { timeout: 120_000 }, async () => {
  const site = createServer((_request, reply) => { reply.setHeader("Content-Type", "text/html; charset=utf-8"); reply.end(PAGE); });
  const href = (await listen(site)) + "/";
  const gateway = await new FakeGateway({ script: () => ({ text: "Only the words arrived." }) }).start();
  let app: ElectronApplication | undefined;
  let folder = "";
  try {
    ({ app, folder } = await launch(gateway, { browserAgent: false, agentMode: false }));
    const page = await app.firstWindow();
    const { comments } = await pickElements(app, page, href);
    await comments.getByRole("button", { name: "Add to message (1)" }).click();
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect(page.getByText("Only the words arrived.", { exact: true })).toBeVisible({ timeout: 30_000 });
    assert.equal(imageParts(gateway).length, 0, "no image for a model without vision");
    assert.match(JSON.stringify(gateway.completions[0]!.body.messages), /Make this button blue\./);
  } finally {
    await app?.close();
    site.close();
    await gateway.stop();
    if (folder) await removeNativeFixtureDirectory(folder);
  }
});

test("a picked element's picture also goes with a follow-up sent while the task runs", { timeout: 120_000 }, async () => {
  const site = createServer((_request, reply) => { reply.setHeader("Content-Type", "text/html; charset=utf-8"); reply.end(PAGE); });
  const href = (await listen(site)) + "/";
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gateway = await new FakeGateway({
    async script(_body, index) {
      if (index === 0) { await held; return { toolCalls: [{ name: "list_files", args: { path: "." } }] }; }
      return { text: "The follow-up arrived with its picture." };
    },
    models: seeingModels,
  }).start();
  let app: ElectronApplication | undefined;
  let folder = "";
  try {
    ({ app, folder } = await launch(gateway, { browserAgent: false, agentMode: false }));
    const page = await app.firstWindow();
    await page.getByRole("textbox", { name: "Code request" }).fill("List the folder.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(() => gateway.completions.length).toBe(1);
    const { comments } = await pickElements(app, page, href);
    await comments.getByRole("button", { name: "Add to message (1)" }).click();
    await page.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect(page.getByText("Make this button blue.", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    release();
    await expect(page.getByText("The follow-up arrived with its picture.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const second = gateway.completions[1]!.body.messages as Array<{ role: string; content: unknown }>;
    assert.ok(second.some(({ role, content }) => role === "user" && typeof content === "string" && content.includes("Make this button blue.")), "the follow-up text reached the model");
    const pictures = second.flatMap(({ content }) => Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "image_url") : []);
    assert.equal(pictures.length, 1, "its picture arrived once");
  } finally {
    release();
    await app?.close();
    site.close();
    await gateway.stop();
    if (folder) await removeNativeFixtureDirectory(folder);
  }
});
