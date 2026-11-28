import assert from "node:assert/strict";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("An external link opens in the isolated link view with its host, a copy button and no system browser", { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-web-view-"));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
    const page = await application.firstWindow();
    await application.evaluate(({ shell }) => {
      const host = globalThis as typeof globalThis & { systemBrowserTargets: string[] };
      host.systemBrowserTargets = [];
      shell.openExternal = async (href) => { host.systemBrowserTargets.push(href); };
    });
    for (const url of ["http://example.com/", "file:///C:/Windows/win.ini", "javascript:alert(1)", "https://localhost/", "https://127.0.0.1:3000/",
      "https://192.168.0.1/", "https://user:pw@example.com/"]) {
      await assert.rejects(page.evaluate((target) => window.desktop.webView({ type: "open-link", url: target }), url), url);
    }
    await expect(page.getByTestId("desktop-web-view")).toHaveCount(0);

    await page.evaluate(() => window.desktop.webView({ type: "open-link", url: "https://example.com/some/page?q=1" }));
    const viewer = page.getByTestId("desktop-web-view");
    await expect(viewer).toHaveAttribute("data-kind", "link");
    await expect(viewer.getByLabel("Current address")).toContainText("example.com");
    await expect(viewer.getByTestId("desktop-web-view-copy")).toBeVisible();
    await expect(viewer.getByRole("navigation", { name: "Contents" })).toHaveCount(0);
    await expect(viewer.getByText("This page is outside Tomverse.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    assert.deepEqual(await application.evaluate(() =>
      (globalThis as typeof globalThis & { systemBrowserTargets: string[] }).systemBrowserTargets), []);
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("A public-looking name that resolves to loopback, or does not resolve, is cancelled before it is loaded", { timeout: 60_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-web-view-dns-"));
  let application: ElectronApplication | undefined;
  type Host = typeof globalThis & { lookups: string[]; failures: Array<{ code: number; url: string }> };
  try {
    await writeFile(join(profile, "language.txt"), "en");
    application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
    const page = await application.firstWindow();
    await application.evaluate(({ app }) => {
      const host = globalThis as Host;
      host.lookups = [];
      host.failures = [];
      // A stand-in for DNS in the link view's own session; no lookup or connection leaves the machine.
      app.on("session-created", (created) => {
        created.resolveHost = async (name) => {
          host.lookups.push(name);
          if (name === "rebind.example.com") return { endpoints: [{ address: "127.0.0.1", family: "ipv4" }] };
          throw new Error("ERR_NAME_NOT_RESOLVED");
        };
      });
      app.on("web-contents-created", (_event, contents) => {
        contents.on("did-fail-load", (_failure, code, _description, url, mainFrame) => { if (mainFrame) host.failures.push({ code, url }); });
      });
    });
    const viewer = page.getByTestId("desktop-web-view");
    const seen = () => application!.evaluate(() => ({ lookups: (globalThis as Host).lookups, failures: (globalThis as Host).failures }));
    for (const url of ["https://rebind.example.com/start", "https://unresolved.example.com/start"]) {
      await page.evaluate((target) => window.desktop.webView({ type: "open-link", url: target }), url);
      await expect(viewer).toHaveAttribute("data-kind", "link");
      await expect(viewer.getByRole("alert")).toContainText("This page could not be loaded.");
      // -20 is ERR_BLOCKED_BY_CLIENT: the session's request filter cancelled the navigation after the lookup.
      await expect.poll(async () => (await seen()).failures.filter((failure) => failure.url === url)).toEqual([{ code: -20, url }]);
    }
    assert.deepEqual((await seen()).lookups, ["rebind.example.com", "unresolved.example.com"]);
    await viewer.getByTestId("desktop-web-view-close").click();
    await expect(viewer).toHaveCount(0);
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("A link in a Code answer opens in the link view instead of doing nothing", { timeout: 60_000 }, async (context) => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-web-view-code-"));
  context.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(tmp, "project");
  const profile = join(tmp, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  const gateway = await new FakeGateway({
    routedModel: "fake-small",
    script: () => ({ text: "Read https://example.com/guide, then open http://127.0.0.1:9/private." }),
  }).start();
  context.after(() => gateway.stop());
  const descriptor = join(tmp, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const application = await electron.launch({ executablePath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 30_000 });
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    await openCodeProject(page);
    await selectCodeMode(page, "ask");
    await page.getByRole("textbox", { name: "Code request" }).fill("Where are the docs?");
    await page.getByRole("button", { name: "Send Code request" }).click();
    const answer = page.getByRole("group", { name: "Model response" });
    const link = answer.getByRole("link", { name: "https://example.com/guide" });
    await expect(link).toBeVisible();
    await expect(answer.getByRole("link")).toHaveCount(1);
    await link.click();
    const viewer = page.getByTestId("desktop-web-view");
    await expect(viewer).toHaveAttribute("data-kind", "link");
    await expect(viewer.getByLabel("Current address")).toContainText("example.com");
    await viewer.getByTestId("desktop-web-view-close").click();
    await expect(viewer).toHaveCount(0);
  } finally {
    await application.close();
  }
});
