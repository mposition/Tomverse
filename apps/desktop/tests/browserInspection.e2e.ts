import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

function gate() {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

test("Code reads the live loopback tab only after a task-specific share and loses access when the user revokes it", { timeout: 60_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-browser-inspection-"));
  const descriptor = join(folder, "fixture.json");
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const loaded = gate();
  const shared = gate();
  const empty = gate();
  const revoked = gate();
  const gateway = await new FakeGateway({
    async script(_body, index) {
      if (index <= 3) {
        await [loaded, shared, empty, revoked][index].wait;
        return { toolCalls: [{ id: "snapshot-" + index, name: "snapshot_browser", args: {} }] };
      }
      return { text: "Browser inspection complete." };
    },
  }).start();
  const site = createServer((_request, reply) => {
    reply.setHeader("Content-Type", "text/html; charset=utf-8");
    reply.end("<title>Inspection fixture</title><h1>Text from the running local site</h1>" +
      "<label>Password <input type='password' value='fixture-secret-value'></label>");
  });
  let application: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve, reject) => site.listen(0, "127.0.0.1", resolve).once("error", reject));
    const local = site.address();
    if (!local || typeof local === "string") throw new Error("No fixture address");
    const href = "http://127.0.0.1:" + local.port + "/";
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, browserInspection: true }));
    application = await launchNativeFixture(descriptor);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByLabel("Code mode").selectOption("ask");
    await page.getByRole("textbox", { name: "Code request" }).fill("Read the local page I share.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).task?.status).toBe("running");
    await expect.poll(async () => Boolean((await page.evaluate(() => window.desktop.state())).task?.id)).toBe(true);
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const address = page.getByRole("textbox", { name: "Local development URL" });
    await address.fill(href);
    await address.press("Enter");
    const share = page.getByRole("button", { name: "Share this page with Code" });
    await expect(share).toBeEnabled();
    loaded.release();
    await expect.poll(() => gateway.completions.length).toBe(2);
    const replies = (index: number) => (gateway.completions[index]?.body.messages as Array<{ role: string; content: unknown }>)
      .filter(({ role }) => role === "tool").map(({ content }) => JSON.stringify(content));
    assert.match(replies(1).at(-1)!, /No local browser tab is shared/);
    await share.click();
    const stopSharing = page.getByRole("button", { name: "Stop sharing with Code" });
    await expect(stopSharing).toBeVisible();
    shared.release();
    await expect.poll(() => gateway.completions.length).toBe(3);
    const observed = replies(2).at(-1)!;
    assert.match(observed, /Text from the running local site/);
    assert.doesNotMatch(observed, /fixture-secret-value/);
    const inspected = application.context().pages().find((candidate) => candidate.url() === href);
    assert.ok(inspected);
    await inspected.evaluate(() => { document.body.replaceChildren(); });
    empty.release();
    await expect.poll(() => gateway.completions.length).toBe(4);
    assert.match(replies(3).at(-1)!, /status.*ok.*text/);
    assert.doesNotMatch(replies(3).at(-1)!, /No local browser tab/);
    await stopSharing.click();
    await expect(share).toBeVisible();
    revoked.release();
    await expect(page.getByText("Browser inspection complete.", { exact: true })).toBeVisible();
    assert.match(replies(4).at(-1)!, /No local browser tab is shared/);
  } finally {
    loaded.release();
    shared.release();
    empty.release();
    revoked.release();
    await application?.close();
    site.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
