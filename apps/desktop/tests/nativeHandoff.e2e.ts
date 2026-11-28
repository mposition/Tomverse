import assert from "node:assert/strict";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect } from "@playwright/test";
import { FakeGateway, lastUserText, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { selectExcerpt } from "./handoff-fixture";
import { launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
const qwen = process.env.TOMVERSE_DESKTOP_QWEN_TASK_BINARY;

test("Chat hands an approved excerpt only to the confirmed Code execution route", {
  timeout: 180_000,
  skip: !authOrigin || !qwen || process.env.TOMVERSE_DESKTOP_TASK_QA_EXECUTABLE ? "Requires the development auth fixture and pinned Qwen Code" : false,
}, async () => {
  assert.ok(authOrigin && qwen);
  assert.match(authOrigin, /^http:\/\/127\.0\.0\.1:\d{4,5}$/);
  const directory = await mkdtemp(join(tmpdir(), "tomverse-native-handoff-"));
  const root = join(directory, "project"), profile = join(directory, "profile"), descriptor = join(directory, "fixture.json");
  const gateway = new FakeGateway({ script: () => ({ text: "The API ran unexpectedly." }) });
  const model = "qwen-handoff-fixture";
  const excerpt = "echo selected words only";
  const chat = { id: "handoff-chat", title: "Chat excerpt fixture", kind: "chat", surface: "chat", productKey: "chat" };
  const responseText = "The provider received the selected excerpt.";
  const providerRequests: Array<Parameters<typeof lastUserText>[0]> = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    providerRequests.push(JSON.parse(Buffer.concat(parts).toString()));
    const chunk = { id: "fixture-handoff", object: "chat.completion.chunk", created: 1, model };
    const event = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(event({ role: "assistant", content: responseText }, null) + event({}, "stop") + "data: [DONE]\n\n");
  });
  provider.on("connect", (_request, socket) => socket.destroy());
  let app: Awaited<ReturnType<typeof launchNativeFixture>> | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY,
      qwen: { executable: qwen, version: "0.28.4", model, origin: `http://127.0.0.1:${address.port}`, allowSavedHistory: true },
    }));
    app = await launchNativeFixture(descriptor);
    await app.evaluate(({ shell, dialog }, { origin, conversation, selectedText }) => {
      const host = globalThis as typeof globalThis & { excerptPreview?: string };
      const realFetch = globalThis.fetch;
      shell.openExternal = async (href) => {
        const url = new URL(href);
        if (url.origin !== origin || url.pathname !== "/auth/desktop") throw new Error("Unexpected auth destination.");
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        if (callback.hostname !== "127.0.0.1" || callback.pathname !== "/desktop-login/callback") throw new Error("Invalid test callback.");
        callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        const result = await realFetch(callback);
        if (!result.ok) throw new Error("The synthetic account could not be connected.");
      };
      dialog.showMessageBox = async (_window: unknown, options?: Electron.MessageBoxOptions) => {
        host.excerptPreview = options?.detail;
        return { response: 1, checkboxChecked: false };
      };
      globalThis.fetch = async (value, init) => {
        const url = new URL(String(value));
        if (url.origin !== origin) {
          if (url.hostname !== "127.0.0.1") throw new Error("The test only allows loopback requests.");
          return realFetch(value, init);
        }
        if (url.pathname === "/api/auth/desktop/exchange") {
          return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        }
        if (url.pathname === "/api/auth/desktop/session") {
          return Response.json({ ok: true, account: { id: "handoff-account", name: "Handoff Fixture", email: null } });
        }
        if (url.pathname === "/api/products/chat/capabilities") return Response.json({ autoSelection: { offered: false }, desktopWrite: true });
        if (url.pathname === "/api/conversations") return Response.json([conversation]);
        if (url.pathname === `/api/conversations/${conversation.id}`) return Response.json({ ...conversation,
          messages: [{ id: "user-message", role: "user", content: `Private prefix. ${selectedText}. Private suffix.` },
            { id: "another-message", role: "assistant", content: "Another private message.", memoryUsedCount: 1 }],
          messagePage: { nextCursor: null }, selectionMode: "manual", selectedModels: [], autoSelection: { offered: false },
        });
        return Response.json({}, { status: 404 });
      };
    }, { origin: authOrigin, conversation: chat, selectedText: excerpt });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Sign in with your browser" }).click();
    await expect.poll(async () => page.evaluate(() => window.desktop.state().then(({ account }) => account.stage))).toBe("connected");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await openCodeProject(page);
    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    const approve = async () => {
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page.getByRole("button", { name: chat.title, exact: true }).click();
      await selectExcerpt(page.locator('[data-handoff-content="chat"]').filter({ hasText: excerpt }), excerpt);
      await page.getByRole("button", { name: "Use selection in Code" }).click();
      await selectCodeMode(page, "ask");
      return page.evaluate(() => window.desktop.state().then(({ handoff }) => handoff));
    };
    const approved = await approve();
    assert.ok(approved);
    const send = page.getByRole("button", { name: "Send Code request", exact: true });
    await expect(send).toBeEnabled();
    const preview = await app.evaluate(() => (globalThis as typeof globalThis & { excerptPreview?: string }).excerptPreview);
    assert.ok(preview && preview.includes(approved.project));
    assert.match(preview, /Qwen Code/);
    assert.match(preview, /echo selected words only/);
    assert.doesNotMatch(preview, /Private prefix|Private suffix|Another private message/);
    assert.equal(providerRequests.length, 0);
    assert.equal(gateway.completions.length, 0);

    await page.evaluate(() => window.desktop.setCodeExecutionPreference("tomverse_api"));
    await expect.poll(() => page.evaluate(() => window.desktop.state().then(({ handoff }) => handoff))).toBeNull();
    await assert.rejects(page.evaluate((handoffId) => window.desktop.start({
      prompt: "", handoffId, model: "fake-coder", mode: "ask", effort: "default", executionMode: "tomverse_api",
    }), approved.id), /Choose the excerpt again/);
    assert.equal(gateway.completions.length, 0);

    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    const fresh = await approve();
    assert.ok(fresh);
    await assert.rejects(page.evaluate(({ handoffId, modelId, credential }) => window.desktop.start({
      prompt: credential, handoffId, model: modelId, mode: "ask", effort: "default", executionMode: "provider_cli", saveHistory: false,
    }), { handoffId: fresh.id, modelId: model, credential: TEST_KEY }), /contains a Tomverse credential/);
    assert.equal(providerRequests.length, 0);
    await send.click();
    await expect.poll(async () => {
      const { task, busy } = await page.evaluate(() => window.desktop.state());
      return { busy, status: task?.status, requests: providerRequests.length, entries: task?.entries };
    }, { timeout: 100_000 }).toMatchObject({ busy: false, status: "completed" });
    await expect(page.getByText(responseText, { exact: true })).toBeVisible();
    assert.equal(providerRequests.length, 1);
    const [request] = providerRequests;
    const parts: Array<{ type: string; text: string }> = JSON.parse(lastUserText(request));
    assert.deepEqual(parts.filter(({ text }) => !text.startsWith("<system-reminder>")), [
      { type: "text", text: `Excerpt from Chat\n${excerpt}` },
    ]);
    assert.deepEqual(request.tools.map(({ function: tool }: { function: { name: string } }) => tool.name).sort(), ["read_file", "todo_write"]);
    assert.doesNotMatch(JSON.stringify(providerRequests), /Private prefix|Private suffix|Another private message|fixture-access|fixture-refresh/);
    assert.equal(gateway.completions.length, 0);
    assert.equal(await page.evaluate(() => window.desktop.state().then(({ handoff }) => handoff)), null);
  } finally {
    await app?.close();
    provider.closeAllConnections();
    if (provider.listening) await new Promise<void>((resolve) => provider.close(() => resolve()));
    await gateway.stop();
    await removeNativeFixtureDirectory(directory);
  }
});
