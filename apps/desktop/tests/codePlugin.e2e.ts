import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { MAX_CODE_PROMPT_CHARACTERS } from "../src/contract";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
const deviceFixture = process.env.TOMVERSE_DESKTOP_DEVICE_FIXTURE === "true";
test("Code scopes MCP to the selected task and aborts a dispatched read on Stop", { timeout: 60_000, skip: !authOrigin }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-code-mcp-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({
    script(_body, index) {
      if (index === 0 || index === 6) return { toolCalls: [{ name: "list_plugin_tools", args: {} }] };
      if (index === 1) return { toolCalls: [{ name: "read_plugin", args: { name: "create_note", args: { text: "blocked" } } }] };
      const id = new Map([[2, "fixture-access"], [3, "token-response"], [4, "release"], [7, "slow"]]).get(index);
      if (id) return { toolCalls: [{ name: "read_plugin", args: { name: "read", args: { id } } }] };
      return { text: "Read complete." };
    },
  }).start();
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launchNativeFixture(descriptor, 20_000, deviceFixture ? ["--use-fake-device-for-media-stream"] : []);
    await app.evaluate(({ shell }, origin) => {
      const host = globalThis as typeof globalThis & { scopedCalls?: string[]; clips?: number; reviewSends?: number };
      const realFetch = globalThis.fetch;
      host.scopedCalls = [];
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
        if (target.pathname === "/api/auth/desktop/exchange") return Response.json({
          ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600,
        });
        if (target.pathname === "/api/auth/desktop/session") return Response.json({
          ok: true, account: { id: "mcp-fixture", name: "MCP fixture", email: null },
        });
        if (target.pathname === "/api/products/chat/capabilities") return Response.json({
          autoSelection: { offered: false }, desktopPlugins: true, desktopCodeMcp: true,
          desktopReview: { easy: true, modelLimit: 3, plan: "Max" },
        });
        if (target.pathname === "/api/chat/voice-transcription") {
          const headers = new Headers(options?.headers);
          if (options?.method !== "POST" || headers.get("origin") !== "tomverse://desktop" ||
            headers.get("authorization") !== "Bearer fixture-access" || !headers.get("content-type")?.startsWith("audio/") ||
            !(options.body instanceof Uint8Array) || options.body.length < 2_048) {
            return Response.json({ code: "VOICE_TRANSCRIPTION_FAILED" }, { status: 400 });
          }
          host.clips = (host.clips ?? 0) + 1;
          return Response.json({ transcript: "Fixture dictation." });
        }
        if (target.pathname === "/api/chat" && options?.method === "POST") host.reviewSends = (host.reviewSends ?? 0) + 1;
        if (target.pathname === "/api/conversations") return Response.json([]);
        if (target.pathname === "/api/mcp/connections") return Response.json({
          enabled: true, servers: [], connections: [{ id: "account-mcp", serverId: "fixture", name: "Fixture docs", status: "connected", tools: 2, granted: 2 }],
        });
        if (target.pathname !== "/api/mcp/desktop-code") return Response.json({}, { status: 404 });
        const headers = new Headers(options?.headers);
        if (headers.get("authorization") !== "Bearer fixture-access" || headers.get("origin") !== "tomverse://desktop" ||
          options?.method !== "POST") throw new Error("Unexpected scoped request.");
        const { connectionId, action } = JSON.parse(String(options.body));
        if (connectionId !== "account-mcp") throw new Error("Unexpected plugin selection.");
        if (action.type === "list") {
          host.scopedCalls!.push("list");
          return Response.json({ type: "list", version: 4, tools: [{ name: "read", inputSchema: { type: "object" } }] });
        }
        if (action.name !== "read" || action.version !== 4) throw new Error("Unexpected remote tool.");
        host.scopedCalls!.push(action.args.id);
        if (action.args.id === "slow") {
          return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
            host.scopedCalls!.push("aborted");
            reject(new Error("Aborted read."));
          }, { once: true }));
        }
        return Response.json({ type: "result", content: action.args.id === "token-response" ? "fixture-refresh" : "Scoped external document",
          status: "ok", sources: [] });
      };
    }, authOrigin);
    const page = await app.firstWindow();
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).account.stage).toBe("connected");
    await rail.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await expect(page.getByRole("button", { name: "Add a place", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Plugin for this task", { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).models.length).toBeGreaterThan(0);
    await assert.rejects(page.evaluate(async () => {
      const model = (await window.desktop.state()).models[0]!.id;
      return window.desktop.start({ prompt: "Reject this Agent invocation", mode: "agent", model, effort: "default", saveHistory: false,
        pluginConnectionId: "account-mcp" });
    }), /Code plugins require a connected account and an Ask task/);
    await page.getByLabel("Code mode").selectOption("ask");
    const codeDraft = page.getByRole("textbox", { name: "Code request" });
    await codeDraft.fill("x".repeat(MAX_CODE_PROMPT_CHARACTERS));
    await page.getByRole("button", { name: "Add a place", exact: true }).click();
    const placeDialog = page.getByRole("dialog", { name: "Add a place" });
    await placeDialog.getByRole("textbox", { name: "City or area" }).fill("Brisbane");
    await expect(placeDialog.getByRole("button", { name: "Add place to draft" })).toBeDisabled();
    await page.keyboard.press("Escape");
    assert.equal((await codeDraft.inputValue()).length, MAX_CODE_PROMPT_CHARACTERS);
    await codeDraft.fill("Find the closest library");
    await page.getByRole("button", { name: "Add a place", exact: true }).click();
    await expect(placeDialog.getByRole("button", { name: "Attach current location" })).toHaveCount(0);
    await placeDialog.getByRole("button", { name: "Add place to draft" }).click();
    await expect(codeDraft).toHaveValue("Find the closest library\n\nMy location: Brisbane");
    assert.equal(gateway.completions.length, 0);
    const select = async () => {
      const picker = page.getByRole("combobox", { name: "Plugin for this task" });
      if (!await picker.isVisible()) await page.locator("summary").filter({ has: page.locator("svg.lucide-puzzle") }).click();
      await picker.selectOption("account-mcp");
      await expect(page.getByRole("checkbox", { name: "Save to local history" })).not.toBeChecked();
    };
    const calls = () => app!.evaluate(() =>
      (globalThis as typeof globalThis & { scopedCalls?: string[] }).scopedCalls);
    await select();
    await page.getByRole("textbox", { name: "Code request" }).fill("Read the release document from the selected plugin.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect(page.getByText("Read complete.", { exact: true })).toBeVisible();
    assert.deepEqual(await calls(), ["list", "token-response", "release"]);
    assert.match(JSON.stringify(gateway.completions[2]?.body.messages), /List the approved read tools first/);
    assert.match(JSON.stringify(gateway.completions[5]?.body.messages), /Scoped external document/);
    assert.doesNotMatch(JSON.stringify(gateway.completions), /fixture-refresh/);
    const namespaces = await readdir(join(profile, "code")).catch(() => []);
    for (const namespace of namespaces) {
      assert.deepEqual(await readdir(join(profile, "code", namespace, "sessions")).catch(() => []), []);
    }
    await select();
    await page.getByRole("textbox", { name: "Code request" }).fill("Start a slow read.");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(calls).toEqual(["list", "token-response", "release", "list", "slow"]);
    await page.getByRole("button", { name: "Stop Code task", exact: true }).click();
    await expect.poll(calls).toEqual(["list", "token-response", "release", "list", "slow", "aborted"]);
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).busy).toBe(false);
    assert.deepEqual(await page.evaluate(async () => {
      const { task } = await window.desktop.state();
      if (!task?.id) throw new Error("Expected a stopped task.");
      const resumed = await window.desktop.resume(task.id);
      const continued = await window.desktop.followUp(task.id, "Reuse previous plugin output.");
      return { resumed, continued, resumable: Boolean(task.canResume), clarification: Boolean(task.canAnswerClarification) };
    }), { resumed: false, continued: false, resumable: false, clarification: false });
    if (deviceFixture) {
      const requests = gateway.completions.length;
      const record = page.getByRole("button", { name: "Record voice input", exact: true });
      const useRecording = page.getByRole("button", { name: "Use recording as text", exact: true });
      const recordText = async () => {
        await record.click();
        await expect(page.getByRole("status").filter({ hasText: /^Recording [1-9][0-9]*s$/ })).toBeVisible();
        await useRecording.click();
      };
      await codeDraft.fill("Edit before sending");
      await recordText();
      await expect(codeDraft).toHaveValue("Edit before sending Fixture dictation.");
      await codeDraft.fill("Editable Code draft");
      assert.equal(gateway.completions.length, requests);
      await rail.getByRole("button", { name: "Review", exact: true }).click();
      const reviewDraft = page.getByRole("textbox", { name: "Review question" });
      await reviewDraft.fill("Compare the replies");
      await recordText();
      await expect(reviewDraft).toHaveValue("Compare the replies Fixture dictation.");
      await record.click();
      await expect(useRecording).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(record).toBeEnabled();
      assert.deepEqual(await app.evaluate(() => {
        const host = globalThis as typeof globalThis & { clips?: number; reviewSends?: number };
        return [host.clips ?? 0, host.reviewSends ?? 0];
      }), [2, 0]);
    }
  } finally {
    await app?.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
