import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

// Remote control end to end in the real main process: the setting turns on only after the native dialog, the PC
// reports the approval card on its screen, an answer from "another device" (the stubbed server) closes that very card
// through the approval window's own path, the report holds no key or file contents, and turning the setting off
// deletes the server's copy. The server is the main process's own fetch, replaced for the fixture account origin.

const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;

type Sync = { snapshot: { tasks: Array<{ key: string; status: string }>; approval: null | { id: string; taskKey: string; digest: string; remote: boolean } };
  acks: Array<{ id: string; result: string; reason?: string }> };

test("an answer from another device closes the approval on the PC's screen, once", { timeout: 120_000, skip: !authOrigin }, async () => {
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      if (fixtureOperationResults(body).length === 0) {
        return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", "console.log('remote ok')"] } }] };
      }
      return { text: "Command finished on the PC." };
    },
  }).start();
  const folder = await mkdtemp(join(tmpdir(), "tomverse-remote-control-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(join(root, "secret-notes.txt"), "file-content-that-must-stay-local");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launchNativeFixture(descriptor);
    await app.evaluate(({ shell, dialog }, origin) => {
      const host = globalThis as typeof globalThis & { remote?: { syncs: unknown[]; deletes: number; sent: string[]; asked: number } };
      const realFetch = globalThis.fetch;
      host.remote = { syncs: [], deletes: 0, sent: [], asked: 0 };
      dialog.showMessageBox = (async () => { host.remote!.asked += 1; return { response: 1, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
      shell.openExternal = async (href) => {
        const target = new URL(href);
        if (target.origin !== origin || target.pathname !== "/auth/desktop") throw new Error("Unexpected browser destination.");
        const callback = new URL(target.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the test account.");
      };
      globalThis.fetch = async (payload, options) => {
        const target = new URL(String(payload));
        if (target.origin !== origin) return realFetch(payload, options);
        if (target.pathname === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        if (target.pathname === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "remote-fixture", name: "Remote fixture", email: null } });
        if (target.pathname === "/api/products/chat/capabilities") return Response.json({ autoSelection: { offered: false } });
        if (target.pathname === "/api/conversations") return Response.json([]);
        if (target.pathname !== "/api/desktop/remote/sync") return Response.json({}, { status: 404 });
        const headers = new Headers(options?.headers);
        if (headers.get("authorization") !== "Bearer fixture-access" || headers.get("origin") !== "tomverse://desktop" || headers.has("cookie")) {
          return Response.json({ ok: false }, { status: 401 });
        }
        if (options?.method === "DELETE") { host.remote!.deletes += 1; return new Response(null, { status: 204 }); }
        const body = JSON.parse(String(options?.body)) as { snapshot: { approval: null | { id: string; taskKey: string; digest: string; remote: boolean } } };
        host.remote!.syncs.push(body);
        const approval = body.snapshot.approval;
        const commands = [];
        // "Another device" answers the card once, as reported, and the same answer arrives twice.
        if (approval?.remote && !host.remote!.sent.length) {
          const id = crypto.randomUUID();
          host.remote!.sent.push(id, id);
          const command = { id, kind: "approval", deviceId: "pc-1", taskKey: approval.taskKey, approvalId: approval.id, digest: approval.digest, decision: "once", ageMs: 40 };
          commands.push(command, command);
        }
        return Response.json({ ok: true, deviceId: "pc-1", commands });
      };
    }, authOrigin);
    const remote = () => app!.evaluate(() => (globalThis as typeof globalThis & { remote: { syncs: Sync[]; deletes: number; sent: string[]; asked: number } }).remote);

    const page = await app.firstWindow();
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).account.stage).toBe("connected");

    // Off by default; turning it on asks first; the screen says what is sent.
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    const setting = page.getByTestId("remote-control-setting");
    const control = setting.getByLabel("Allow control of this PC from other devices");
    await expect(control).toHaveValue("off");
    await expect(setting.getByTestId("remote-control-sent")).toContainText("File contents, diffs, command output, environment values and credentials are not sent.");
    await control.selectOption("on");
    await expect(control).toHaveValue("on");
    await expect(setting.getByTestId("remote-control-page")).toContainText(authOrigin + "/remote");
    assert.equal((await remote()).asked, 1);
    assert.equal((await remote()).syncs.length, 0, "nothing runs, so nothing is sent");

    await rail.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByLabel("Code mode").selectOption("agent");
    await page.getByRole("textbox", { name: "Code request" }).fill("Run the check");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 20_000 }), page.getByRole("button", { name: "Send Code request" }).click()]);
    // Nobody touches the PC's approval window: the answer from the other device closes it.
    await approval.waitForEvent("close", { timeout: 30_000 });
    await expect(page.getByText("Command finished on the PC.", { exact: true })).toBeVisible({ timeout: 30_000 });

    await expect.poll(async () => (await remote()).syncs.flatMap((sync) => sync.acks).map((ack) => ack.reason ?? ack.result), { timeout: 20_000 })
      .toEqual(["applied", "duplicate"]);
    const { syncs, sent } = await remote();
    const answered = syncs.find((sync) => sync.snapshot.approval?.remote)!.snapshot.approval!;
    assert.equal(sent[0], sent[1]);
    assert.equal(gateway.completions.filter((completion) => JSON.stringify(completion.body).includes("remote ok")).length > 0, true, "the command ran after the answer");
    const reported = JSON.stringify(syncs);
    for (const leaked of [TEST_KEY, "fixture-access", "fixture-refresh", "file-content-that-must-stay-local"]) assert.equal(reported.includes(leaked), false, leaked);
    assert.ok(answered.digest.match(/^[a-f0-9]{64}$/));

    // The task ended: one last report says nothing runs, and then nothing is sent.
    await expect.poll(async () => (await remote()).syncs.at(-1)?.snapshot.tasks.length, { timeout: 20_000 }).toBe(0);
    const settled = (await remote()).syncs.length;
    await page.waitForTimeout(3_000);
    assert.equal((await remote()).syncs.length, settled);

    // Turning it off deletes the server's copy.
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await page.getByTestId("remote-control-setting").getByLabel("Allow control of this PC from other devices").selectOption("off");
    await expect.poll(async () => (await remote()).deletes).toBe(1);
  } finally {
    await app?.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
