import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

test("GitHub PRs are attached to the selected saved task with accessible current-head evidence", { timeout: 60_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-task-pulls-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done for this task." }) }).start();
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    const open = async () => {
      app = await launchNativeFixture(descriptor);
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Open local folder" }).click();
      return page;
    };
    const page = await open();
    await app!.evaluate(() => {
      const pass = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        if (url.hostname !== "api.github.com") return pass(input, options);
        if (options?.method !== "GET" || new Headers(options.headers).has("authorization")) {
          return Promise.reject(new Error("Expected an unauthenticated read"));
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        const head = "a".repeat(40);
        if (url.pathname === "/repos/example/site/pulls/34") return Promise.resolve(Response.json({
          number: 34, head: { sha: head }, base: { ref: "main", repo: { full_name: "example/site" } },
          merge_commit_sha: null, merged: false, mergeable: true, state: "open",
        }));
        if (url.pathname.endsWith("/protection/required_status_checks")) {
          return Response.json({ checks: [{ context: "build", app_id: 7 }] });
        }
        if (url.pathname.endsWith("/check-runs")) return Promise.resolve(Response.json({
          total_count: 1, check_runs: [{ name: "build", head_sha: head, conclusion: "failure", app: { id: 7 } }],
        }));
        return Promise.resolve(new Response(null, { status: 404 }));
      };
    });
    const composer = page.getByRole("textbox", { name: "Code request" });
    const send = page.getByRole("button", { name: "Send Code request" });
    await composer.fill("First task");
    await send.click();
    await expect(page.getByText("Done for this task.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Linked GitHub pull requests", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Linked GitHub pull requests" });
    await modal.getByRole("textbox", { name: "Public GitHub pull request URL" }).fill("https://github.com/example/site/pull/34");
    await modal.getByRole("button", { name: "Link and check" }).click();
    await expect(modal.getByText("Current commit has failing checks", { exact: true })).toBeVisible();
    await expect(modal.getByText("example/site · #34", { exact: true })).toBeVisible();
    const raced = await page.evaluate(async () => {
      const link = { url: "https://github.com/example/site/pull/34", environment: "" };
      const operations = await Promise.allSettled([
        window.desktop.taskPulls({ type: "read", link }), window.desktop.taskPulls({ type: "read", link }),
      ]);
      return operations.map(({ status }) => status).sort();
    });
    assert.deepEqual(raced, ["fulfilled", "rejected"]);
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await app!.close();
    const resumed = await open();
    await resumed.getByRole("button", { name: "First task", exact: true }).click();
    const indicator = resumed.getByRole("button", { name: "Linked GitHub pull requests · Current commit has failing checks" });
    await expect(indicator).toHaveAttribute("data-state", "failed");
    await resumed.getByRole("button", { name: "New task", exact: true }).click();
    assert.equal(await indicator.count(), 0);
  } finally {
    await app?.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
