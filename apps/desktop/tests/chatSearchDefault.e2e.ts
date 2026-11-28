import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const origin = process.env.DESKTOP_E2E_AUTH_ORIGIN;

type SearchFixture = { patches: Array<Record<string, unknown>>; turns: Array<{ webSearchMode?: string }>; stored: string };
const fixtureState = (app: ElectronApplication) => app.evaluate(() => (globalThis as typeof globalThis & { searchFixture: SearchFixture }).searchFixture);

/**
 * A signed-in Chat on a faked server that offers the composer tools. The faked server starts every conversation with search OFF,
 * so a first request that carries "always" can only have come from the app itself, not from a server default.
 */
async function launch() {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-search-"));
  await writeFile(join(profile, "language.txt"), "en");
  const app = await electron.launch({ executablePath, args: [desktopDir, "--user-data-dir=" + profile], timeout: 20_000 });
  await app.evaluate(({ shell }, fixtureOrigin) => {
    const host = globalThis as typeof globalThis & { searchFixture: SearchFixture };
    host.searchFixture = { patches: [], turns: [], stored: "off" };
    const state = host.searchFixture;
    const chat = { id: "search-chat", title: "Search fixture", kind: "chat", surface: "chat", productKey: "chat" };
    const messages: Array<Record<string, unknown>> = [];
    let created = false;
    const realFetch = globalThis.fetch;
    shell.openExternal = async (href) => {
      const target = new URL(href);
      if (target.origin !== fixtureOrigin || target.pathname !== "/auth/desktop") throw new Error("Unexpected browser destination.");
      const callback = new URL(target.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
      if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the fixture account.");
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== fixtureOrigin) return new Response(null, { status: 404 });
      const path = "/api/conversations/" + chat.id;
      if (url.pathname === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
      if (url.pathname === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "search-fixture", name: "Search Fixture", email: "search@example.test" } });
      if (url.pathname === "/api/products/chat/capabilities") return Response.json({ autoSelection: { offered: false }, desktopWrite: true, desktopComposerTools: true });
      if (url.pathname === "/api/models/catalog") {
        return Response.json({ models: [{ id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", minimumPlan: "Guest", publiclyListed: true, status: "enabled", enabled: true }] });
      }
      if (url.pathname === "/api/conversations") return Response.json(created ? [{ ...chat, selectedModels: ["gpt-6-luna"] }] : []);
      if (url.pathname === "/api/products/chat/conversations" && init?.method === "POST") { created = true; return Response.json({ id: chat.id }); }
      if (url.pathname === path && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        state.patches.push(body);
        if (body.webSearchMode) state.stored = body.webSearchMode;
        return Response.json({ id: chat.id });
      }
      if (url.pathname === path) {
        return Response.json({ ...chat, messages, selectedModels: ["gpt-6-luna"], messagePage: { nextCursor: null },
          selectionMode: "manual", autoSelection: { offered: false }, webSearchMode: state.stored });
      }
      if (url.pathname === path + "/messages") {
        const [saved] = JSON.parse(String(init?.body)).messages;
        const id = "question-" + messages.length;
        messages.push({ id, role: "user", content: saved.content, status: "normal", createdAt: new Date(10_000 + messages.length).toISOString() });
        return Response.json({ messageMappings: [{ requestId: saved.clientRequestId, messageId: id }] });
      }
      if (url.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: null });
      if (url.pathname === "/api/chat") {
        const body = JSON.parse(String(init?.body));
        state.turns.push({ webSearchMode: body.webSearchMode });
        const reply = "Paris is the capital of France.";
        messages.push({ id: body.assistantMessageId, role: "assistant", modelId: body.modelId, content: reply, status: "normal",
          createdAt: new Date(20_000 + messages.length).toISOString() });
        return new Response(reply);
      }
      return new Response(null, { status: 404 });
    };
  }, origin);
  const desktop = await app.firstWindow();
  await desktop.getByRole("button", { name: "Settings", exact: true }).click();
  await desktop.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
  await expect.poll(() => desktop.evaluate(async () => (await window.desktop.state()).account)).toMatchObject({ stage: "connected" });
  await desktop.getByRole("button", { name: "Chat", exact: true }).click();
  return { app, desktop, profile };
}

test("A new Chat starts with web search on and the first request carries it; the saved Chat keeps that value", { timeout: 120_000, skip: !origin }, async () => {
  const { app, desktop, profile } = await launch();
  try {
    const tools = desktop.locator(".composer-tools");
    await tools.locator("summary").click();
    const search = tools.getByTestId("tools-web-search-row");
    await expect(search).toHaveAttribute("aria-checked", "true");
    await expect(search).toContainText("Searches the web automatically");
    await desktop.keyboard.press("Escape");
    await desktop.getByRole("textbox", { name: "Chat message", exact: true }).fill("What is the capital of France?");
    await desktop.getByRole("button", { name: "Send Chat message", exact: true }).click();
    await expect(desktop.getByText("Paris is the capital of France.").first()).toBeVisible();
    const sent = await fixtureState(app);
    assert.deepEqual(sent.turns, [{ webSearchMode: "always" }]);
    assert.deepEqual(sent.patches, [{ webSearchMode: "always" }], "the app set the mode itself; the faked server had started the Chat with search off");
    await tools.locator("summary").click();
    await expect(search).toHaveAttribute("aria-checked", "true");
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("Turning web search off in a new Chat sends the first question with search off, and the Chat stays off", { timeout: 120_000, skip: !origin }, async () => {
  const { app, desktop, profile } = await launch();
  try {
    const tools = desktop.locator(".composer-tools");
    await tools.locator("summary").click();
    const search = tools.getByTestId("tools-web-search-row");
    await expect(search).toHaveAttribute("aria-checked", "true");
    await search.click();
    await expect(search).toHaveAttribute("aria-checked", "false");
    await desktop.keyboard.press("Escape");
    await desktop.getByRole("textbox", { name: "Chat message", exact: true }).fill("What is the capital of France?");
    await desktop.getByRole("button", { name: "Send Chat message", exact: true }).click();
    await expect(desktop.getByText("Paris is the capital of France.").first()).toBeVisible();
    const sent = await fixtureState(app);
    assert.deepEqual(sent.turns, [{ webSearchMode: "off" }]);
    assert.deepEqual(sent.patches, [{ webSearchMode: "off" }]);
    await tools.locator("summary").click();
    await expect(search).toHaveAttribute("aria-checked", "false");
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
