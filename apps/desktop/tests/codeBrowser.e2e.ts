import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeProject } from "./code-project-fixture";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return "http://127.0.0.1:" + address.port;
}

test("Code opens a native browser panel for the selected loopback site and disposes it when leaving Code", { timeout: 60_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-code-browser-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done" }) }).start();
  let blockedRequests = 0;
  const blockedServer = createServer((_req, reply) => { blockedRequests += 1; reply.end("Other origin"); });
  const blockedOrigin = await listen(blockedServer);
  const requestPaths: string[] = [];
  const site = createServer((req, reply) => {
    const url = new URL(req.url!, "http://localhost");
    requestPaths.push(url.pathname);
    if (url.pathname === "/drop") { req.socket.destroy(); return; }
    if (url.pathname === "/redirect") { reply.writeHead(302, { Location: blockedOrigin + "/redirected" }); reply.end(); return; }
    reply.setHeader("Content-Type", "text/html; charset=utf-8");
    reply.end(url.pathname === "/" ? "<title>Local project</title><main><form action='/result'>" +
      "<label>Search <input name='q'></label><button>Search</button></form><a target='_blank' href='/popup'>Popup</a>" +
      "<img src='" + blockedOrigin + "/asset'></main>" : "<title>Search results</title><h1>Fixture result</h1>");
  });
  const origin = await listen(site);
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    await openCodeProject(page);
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const address = page.getByRole("textbox", { name: "Address" });
    await address.fill("http://example.com/");
    await address.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Enter an https address or a local HTTP address with a port." })).toBeVisible();
    await address.fill(origin + "/");
    await address.press("Enter");
    await expect.poll(() => app!.evaluate(({ webContents }, origin) =>
      webContents.getAllWebContents().find((contents) => contents.getURL() === origin + "/")?.getTitle(), origin)).toBe("Local project");
    const features = await app.evaluate(async ({ webContents }, origin) => {
      const contents = webContents.getAllWebContents().find((contents) => contents.getURL() === origin + "/");
      assertContents(contents);
      return contents.executeJavaScript("[typeof window.desktop, typeof require, typeof process]");
      function assertContents(value: unknown): asserts value {
        if (!value) throw new Error("Missing local browser renderer");
      }
    }, origin);
    assert.deepEqual(features, ["undefined", "undefined", "undefined"]);
    const panel = app.context().pages().find((candidate) => candidate.url() === origin + "/");
    assert.ok(panel);
    await panel.getByText("Popup", { exact: true }).click();
    assert.ok(!requestPaths.includes("/popup"));
    await panel.getByLabel("Search").fill("ordering");
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Fixture result" })).toBeVisible();
    await expect(address).toHaveValue(origin + "/result?q=ordering");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(panel.getByText("Popup", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Forward", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Fixture result" })).toBeVisible();
    const reloadCount = requestPaths.filter((path) => path === "/result").length;
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(() => requestPaths.filter((path) => path === "/result").length).toBeGreaterThan(reloadCount);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Tabs 2" })).toHaveAttribute("aria-selected", "true");
    await expect(address).toHaveValue("");
    await address.fill(origin + "/second");
    await address.press("Enter");
    await expect.poll(() => app!.context().pages().some((candidate) => candidate.url() === origin + "/second")).toBe(true);
    await page.getByRole("tab", { name: "Tabs 2" }).press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Tabs 1" })).toHaveAttribute("aria-selected", "true");
    await expect(address).toHaveValue(origin + "/result?q=ordering");
    await page.getByRole("tab", { name: "Tabs 2" }).click();
    await page.getByRole("button", { name: "Close tab", exact: true }).click();
    await expect.poll(() => app!.context().pages().some((candidate) => candidate.url() === origin + "/second")).toBe(false);
    await expect(address).toHaveValue(origin + "/result?q=ordering");
    const resize = page.getByRole("separator", { name: "Browser", exact: true });
    await resize.press("ArrowLeft");
    await expect(resize).toHaveAttribute("aria-valuenow", "48");
    await address.fill(origin + "/redirect");
    await address.press("Enter");
    await expect.poll(() => requestPaths.includes("/redirect")).toBe(true);
    assert.equal(blockedRequests, 0);
    await address.fill(origin + "/drop");
    await address.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "The page could not load." })).toBeVisible();
    // The panel belongs to the person, not to Code: it stays when they move to Chat, and ends when they close it.
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Browser", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select element" })).toHaveCount(0);
    assert.equal(await app!.evaluate(({ webContents }, origin) =>
      webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(origin)), origin), true);
    await page.getByRole("complementary", { name: "Browser", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => app!.evaluate(({ webContents }, origin) =>
      webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(origin)), origin)).toBe(false);
    await expect(page.getByRole("complementary", { name: "Browser", exact: true })).toHaveCount(0);
    assert.equal(blockedRequests, 0);
  } finally {
    await app?.close();
    site.close();
    blockedServer.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
