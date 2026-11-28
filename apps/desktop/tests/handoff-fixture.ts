import assert from "node:assert/strict";
import { mkdir, rename, rmdir } from "node:fs/promises";
import { expect, type BrowserContext, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { chooseCodeModel } from "./code-model-picker";
import { lastUserText, TEST_KEY, type FakeGateway } from "../../tomverse-cli/tests/fakeGateway.js";

export const codeExcerpt = "Code result excerpt to discuss";
export const codeAnswer = `Extra code evidence outside the selection. ${codeExcerpt}. Other project notes.`;

export async function selectExcerpt(message: Locator, excerpt: string) {
  await expect(message).toBeVisible();
  await message.evaluate((container, text) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.includes(text)) node = walker.nextNode();
    if (!node || !node.textContent) throw new Error("The excerpt was not rendered.");
    const start = node.textContent.indexOf(text);
    const range = new Range();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, excerpt);
}

export async function verifyHandoff(app: ElectronApplication, page: Page, context: BrowserContext, origin: string, project: string, gateway: FakeGateway) {
  const title = "Workspace handoff fixture";
  const chatExcerpt = "echo selection stays text";
  const chatMessage = `Context before. ${chatExcerpt}. Context after.`;
  const created = await context.request.post(`${origin}/api/products/chat/conversations`, { data: { title }, headers: { origin } });
  assert.equal(created.ok(), true, await created.text());
  const { id } = await created.json();
  const saved = await context.request.post(`${origin}/api/conversations/${id}/messages`, {
    data: { messages: [{ id: crypto.randomUUID(), role: "user", content: chatMessage },
      { id: crypto.randomUUID(), role: "user", content: "Separate message in the conversation." }] }, headers: { origin },
  });
  assert.equal(saved.ok(), true, await saved.text());
  const chatPrompts = () => app.evaluate(() => (globalThis as typeof globalThis & { handoffPrompts: Array<{ id: string; prompt: string }> }).handoffPrompts);
  const decision = (accept: boolean) => app.evaluate((_electron, value) => {
    (globalThis as typeof globalThis & { acceptWorkspaceHandoff: boolean }).acceptWorkspaceHandoff = value;
  }, accept);
  const preview = () => app.evaluate(() => (globalThis as typeof globalThis & { handoffPreview: string }).handoffPreview);
  const chatWrites = () => app.evaluate(() => (globalThis as typeof globalThis & { handoffWrites: string[] }).handoffWrites);
  const linkKey = async (key: string) => {
    await app.evaluate((_electron, value) => {
      (globalThis as typeof globalThis & { handoffTestKey: string }).handoffTestKey = value;
    }, key);
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Connect copied key" }).click();
    await expect(page.getByText(`Connected as ${key.slice(0, 12)}`)).toBeVisible();
  };
  await app.evaluate(({ clipboard, dialog }, testOrigin) => {
    const fixture = globalThis as typeof globalThis & {
      handoffPrompts: Array<{ id: string; prompt: string }>; handoffPreview: string; acceptWorkspaceHandoff: boolean; handoffWrites: string[];
      handoffTestKey?: string;
    };
    fixture.handoffPrompts = [];
    fixture.handoffPreview = "";
    fixture.acceptWorkspaceHandoff = false;
    fixture.handoffWrites = [];
    clipboard.readText = async () => fixture.handoffTestKey ?? "";
    dialog.showMessageBox = async (_window: unknown, options?: Electron.MessageBoxOptions) => {
      fixture.handoffPreview = options?.detail ?? "";
      return { response: fixture.acceptWorkspaceHandoff ? 1 : 0, checkboxChecked: false };
    };
    const fetchReal = globalThis.fetch;
    globalThis.fetch = async (target, init) => {
      const url = String(target);
      if (url === `${testOrigin}/api/auth/desktop/code-key` && init?.method === "POST" && fixture.handoffTestKey) {
        const key = JSON.parse(String(init.body)).key;
        if (key !== fixture.handoffTestKey) throw new Error("Unexpected key sent to the test verifier.");
        return Response.json({ ok: true, keyPrefix: key.slice(0, 12) });
      }
      if (init?.method === "POST" && (url === `${testOrigin}/api/chat` || url === `${testOrigin}/api/products/chat/conversations` ||
          (url.startsWith(`${testOrigin}/api/conversations/`) && url.endsWith("/messages")))) fixture.handoffWrites.push(url);
      if (url !== `${testOrigin}/api/chat` || init?.method !== "POST") return fetchReal(target, init);
      const body = JSON.parse(String(init.body));
      fixture.handoffPrompts.push({ id: body.conversationId, prompt: body.messages.at(-1).content });
      return new Response("Discussion fixture answer.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    };
  }, origin);
  try {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    const userText = page.locator('[data-handoff-content="chat"]').filter({ hasText: chatMessage });
    await expect(page.locator('[data-handoff-content="chat"]')).toHaveCount(2);
    await page.getByRole("list", { name: "Chat conversation" }).evaluate(async (thread) => {
      const range = new Range();
      range.selectNodeContents(thread);
      const selected = document.getSelection()!;
      selected.removeAllRanges();
      selected.addRange(range);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(page.getByRole("button", { name: "Use selection in Code" })).toHaveCount(0);
    await selectExcerpt(userText, chatExcerpt);
    await page.getByRole("button", { name: "Use selection in Code" }).click();
    assert.equal((await page.evaluate(() => window.desktop.state())).handoff, null);
    assert.match(await preview(), /echo selection stays text/);
    assert.match(await preview(), /new request and may use credits/);
    assert.doesNotMatch(await preview(), /Context before|Context after/);
    assert.equal(gateway.completions.length, 0);

    await decision(true);
    await selectExcerpt(userText, chatExcerpt);
    await page.getByRole("button", { name: "Use selection in Code" }).click();
    await expect(page.getByRole("form", { name: "Code composer" })).toBeVisible();
    assert.ok((await preview()).includes(project));
    await expect(page.getByText("Excerpt from Chat", { exact: true })).toBeVisible();
    await page.getByText("Excerpt from Chat", { exact: true }).click();
    await expect(page.getByText(chatExcerpt, { exact: true })).toBeVisible();
    const approved = (await page.evaluate(() => window.desktop.state())).handoff!;
    assert.equal(approved.excerpt, chatExcerpt);
    assert.equal(gateway.completions.length, 0);
    assert.deepEqual(await chatPrompts(), []);

    const moved = `${project}-moved`;
    await rename(project, moved);
    await mkdir(project);
    try {
      await assert.rejects(page.evaluate((handoffId) => window.desktop.start({
        prompt: "", handoffId, model: "fake-coder", mode: "ask", effort: "default",
      }), approved.id));
      await page.getByRole("button", { name: "Open local folder" }).click();
      await expect(page.getByText("Excerpt from Chat", { exact: true })).toHaveCount(0);
      assert.equal((await page.evaluate(() => window.desktop.state())).handoff, null);
      await assert.rejects(page.evaluate((handoffId) => window.desktop.start({
        prompt: "", handoffId, model: "fake-coder", mode: "ask", effort: "default",
      }), approved.id), /Choose the excerpt again/);
      assert.equal(gateway.completions.length, 0);
    } finally {
      await rmdir(project);
      await rename(moved, project);
    }
    await page.getByRole("button", { name: "Open local folder" }).click();
    const chatToCode = async () => {
      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page.getByRole("button", { name: title, exact: true }).click();
      await selectExcerpt(userText, chatExcerpt);
      await page.getByRole("button", { name: "Use selection in Code" }).click();
      await expect(page.getByText("Excerpt from Chat", { exact: true })).toBeVisible();
    };
    await chatToCode();

    await page.getByLabel("Code mode").selectOption("ask");
    await chooseCodeModel(page, { model: "fake-coder" });
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect(page.getByText(codeAnswer, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New task", exact: true })).toBeEnabled();
    assert.equal(gateway.completions.length, 1);
    assert.equal(lastUserText(gateway.completions[0]!.body), `Excerpt from Chat\n${chatExcerpt}`);
    assert.equal((await page.evaluate(() => window.desktop.state())).handoff, null);

    const taskId = (await page.evaluate(() => window.desktop.state())).task!.id!;
    assert.equal(await page.evaluate((id) => window.desktop.confirmHandoff({ target: "chat", excerpt: "The entire Code journal", sourceTaskId: id }), taskId), null);
    await assert.rejects(page.evaluate((excerpt) => window.desktop.confirmHandoff({ target: "code", excerpt }), TEST_KEY), /credential/);
    const codeText = page.locator('[data-handoff-content="code"]').filter({ hasText: codeAnswer });
    await selectExcerpt(codeText, codeExcerpt);
    await page.getByRole("button", { name: "Use selection in Chat" }).click();
    await expect(page.getByRole("form", { name: "Chat composer" })).toBeVisible();
    await expect(page.getByText("Excerpt from Code", { exact: true })).toBeVisible();
    assert.ok((await preview()).includes(project));
    assert.match(await preview(), /Code result excerpt to discuss/);
    assert.doesNotMatch(await preview(), /Extra code evidence|Other project notes|echo selection stays text/);
    assert.deepEqual(await chatPrompts(), []);
    assert.equal(gateway.completions.length, 1);
    assert.deepEqual(await chatWrites(), []);

    const chatHandoff = (await page.evaluate(() => window.desktop.state())).handoff!;
    await assert.rejects(page.evaluate(({ handoffId, conversationId }) => window.desktop.sendChat({
      requestId: crypto.randomUUID(), conversationId, prompt: "", handoffId,
      modelId: "gpt-6-luna", selectionMode: "manual", effort: "default",
    }), { handoffId: chatHandoff.id, conversationId: id }), /new Chat draft/);
    await page.getByRole("button", { name: "Send Chat message" }).click();
    await expect.poll(async () => (await chatPrompts()).map(({ prompt }) => prompt)).toEqual([`Excerpt from Code\n${codeExcerpt}`]);
    await expect(page.getByText("Excerpt from Code", { exact: true })).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.desktop.state())).handoff, null);
    await expect(page.getByRole("button", { name: "Send Chat message" })).toBeVisible();

    await page.getByRole("button", { name: "Code", exact: true }).click();
    await selectExcerpt(codeText, codeExcerpt);
    await page.getByRole("button", { name: "Use selection in Chat" }).click();
    await expect(page.getByText("Excerpt from Code", { exact: true })).toBeVisible();
    const abandoned = (await page.evaluate(() => window.desktop.state())).handoff!.id;
    // First replace the fixture connection, then rotate just the key while the endpoint stays the same.
    await linkKey(`tvk_d25proof_${"j".repeat(43)}`);
    assert.equal((await page.evaluate(() => window.desktop.state())).handoff, null);
    await assert.rejects(page.evaluate((handoffId) => window.desktop.sendChat({
      requestId: crypto.randomUUID(), prompt: "", handoffId, modelId: "gpt-6-luna", selectionMode: "manual", effort: "default",
    }), abandoned), /Tomverse could not confirm the Chat change/);
    await chatToCode();
    const beforeRotation = (await page.evaluate(() => window.desktop.state())).handoff!.id;
    await linkKey(`tvk_d25proof_${"k".repeat(43)}`);
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).handoff).toBeNull();
    await page.evaluate((handoffId) => window.desktop.removeHandoff(handoffId), beforeRotation);
    await chatToCode();
    const beforeSignOut = (await page.evaluate(() => window.desktop.state())).handoff!.id;
    await page.evaluate(() => window.desktop.signOut());
    assert.equal((await page.evaluate(() => window.desktop.state())).handoff, null);
    await assert.rejects(page.evaluate((handoffId) => window.desktop.start({
      prompt: "", handoffId, model: "fake-coder", mode: "ask", effort: "default",
    }), beforeSignOut));
    assert.equal((await chatPrompts()).length, 1);
    assert.equal(gateway.completions.length, 1);
  } finally {
    for (const conversationId of new Set([id, ...(await chatPrompts()).map(({ id: savedId }) => savedId)])) {
      const removed = await context.request.delete(`${origin}/api/conversations/${conversationId}`, { headers: { origin } });
      assert.equal(removed.ok(), true, await removed.text());
    }
  }
}
