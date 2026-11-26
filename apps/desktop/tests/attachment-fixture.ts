import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { prisma } from "../../../lib/prisma";

const note = Buffer.from("A local Desktop attachment.\n");
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWNQj9tFEmIY1RA3GkrqwzVpAAAEqD8QpAelQwAAAABJRU5ErkJggg==", "base64");
type AttachmentReference = { attachmentId: string; name: string; mediaType: string; size: number };
type Turn = { conversationId: string; sourceUserMessageId: string; messages: Array<{ content: string; attachments?: AttachmentReference[] }> };
type FixtureObject = { bytes: Buffer; contentType: string };

async function verifyGeneratedSave(application: ElectronApplication, page: Page, turn: Turn, profile: string,
  objects: Map<string, FixtureObject>) {
  const selected = page.getByRole("complementary", { name: "History" }).locator('button[aria-current="page"]');
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: turn.conversationId } });
  const answer = await prisma.message.create({ data: {
    conversationId: conversation.id, role: "assistant", status: "normal", content: "A generated file.",
  } });
  const filename = "결과.txt";
  const contentType = "text/plain; charset=utf-8";
  const bytes = Buffer.from("Exact generated file bytes.\n");
  const objectKey = "generated/desktop-fixture/" + randomUUID() + ".txt";
  const artifact = await prisma.messageArtifact.create({ data: {
    conversationId: conversation.id, userId: conversation.userId, messageId: answer.id, format: "txt",
    filename: "../" + filename, mediaType: contentType, byteSize: bytes.length, objectKey,
  } });
  const filePath = join(profile, filename);
  objects.set(objectKey, { bytes, contentType });
  const selector = page.getByRole("list", { name: "Generated files" });
  await selected.click();
  const save = selector.getByRole("button", { name: "Save " + filename, exact: true });
  await expect(save).toBeVisible();
  const dialogHistory = () => application.evaluate(() =>
    (globalThis as typeof globalThis & { artifactDialogs: Array<string | undefined> }).artifactDialogs);
  await application.evaluate(({ dialog }, destination) => {
    const host = globalThis as typeof globalThis & { artifactDialogs: Array<string | undefined> };
    host.artifactDialogs = [];
    dialog.showSaveDialog = async (_window: unknown, options?: Electron.SaveDialogOptions) => {
      host.artifactDialogs.push(options?.defaultPath);
      return host.artifactDialogs.length === 1 ? { canceled: true, filePath: "" } : { canceled: false, filePath: destination };
    };
  }, filePath);
  await save.click();
  await expect.poll(dialogHistory).toEqual([filename]);
  await expect(save).toBeEnabled();
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
  await expect(selector.getByText("File saved.", { exact: true })).toHaveCount(0);
  await save.click();
  await expect(selector.getByText("File saved.", { exact: true })).toBeVisible();
  assert.deepEqual(await readFile(filePath), bytes);

  await writeFile(filePath, "Keep the existing file");
  await save.click();
  await expect(selector.getByText("The file could not be saved.", { exact: true })).toBeVisible();
  assert.equal(await readFile(filePath, "utf8"), "Keep the existing file");
  assert.deepEqual(await dialogHistory(), [filename, filename, filename]);
  assert.ok((await readdir(profile)).every((entry) => !entry.startsWith(".tomverse-save-")));

  objects.set(objectKey, { bytes: bytes.subarray(0, -2), contentType });
  await save.click();
  await expect(selector.getByText("The file could not be saved.", { exact: true })).toBeVisible();
  assert.deepEqual(await dialogHistory(), [filename, filename, filename]);
  objects.set(objectKey, { bytes, contentType });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { password: "fixture-locked" } });
  try {
    await save.click();
    await expect(selector.getByText("The file could not be saved.", { exact: true })).toBeVisible();
    assert.deepEqual(await dialogHistory(), [filename, filename, filename]);
  } finally {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { password: null } });
  }
  await prisma.messageArtifact.delete({ where: { id: artifact.id } });
  await save.click();
  await expect(selector.getByText("The file could not be saved.", { exact: true })).toBeVisible();
  assert.deepEqual(await dialogHistory(), [filename, filename, filename]);
}

export async function verifyAttachments(application: ElectronApplication, page: Page, origin: string, port: number, profile: string) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const objects = new Map<string, FixtureObject>();
  const uploads: Array<{ authorization: string | undefined; path: string }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    if (request.method === "PUT") {
      uploads.push({ authorization: request.headers.authorization, path: key });
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (key.includes("cancel.txt")) return;
        objects.set(key, { bytes: Buffer.concat(chunks), contentType: String(request.headers["content-type"]) });
        response.writeHead(200, { ETag: '"desktop-fixture-etag"' }).end();
      } catch {
        response.destroy();
      }
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }
    const object = objects.get(key);
    if (!object) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Length": object.bytes.length, "Content-Type": object.contentType, ETag: '"desktop-fixture-etag"' });
    response.end(request.method === "HEAD" ? undefined : object.bytes);
  }).listen(port, "127.0.0.1");
  await once(server, "listening");
  const turns = () => application.evaluate(() => (globalThis as typeof globalThis & { attachmentTurns: Turn[] }).attachmentTurns);
  try {
    await application.evaluate((_electron, appOrigin) => {
      const host = globalThis as typeof globalThis & { attachmentTurns: Turn[] };
      const realFetch = globalThis.fetch;
      host.attachmentTurns = [];
      globalThis.fetch = async (target, init) => {
        const url = String(target);
        if (url === appOrigin + "/api/chat" && init?.method === "POST") {
          host.attachmentTurns.push(JSON.parse(String(init.body)));
          return new Response("Attachment fixture answer.", { headers: { "Content-Type": "text/plain" } });
        }
        if (url === appOrigin + "/api/chat/preflight" && init?.method === "POST") {
          return Response.json({ ok: true, admissionToken: "local-attachment-fixture", contextBundle: null });
        }
        return realFetch(target, init);
      };
    }, origin);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const composer = page.getByRole("form", { name: "Chat composer" });
    const staged = composer.getByRole("list", { name: "Files to attach" });
    const picker = composer.locator('input[type="file"]');
    const send = composer.getByRole("button", { name: "Send Chat message" });
    await picker.setInputFiles([
      { name: "note.txt", mimeType: "text/plain", buffer: note },
      { name: "remove.txt", mimeType: "text/plain", buffer: Buffer.from("Remove me") },
      { name: "unsupported.exe", mimeType: "application/octet-stream", buffer: Buffer.from("Unsupported") },
    ]);
    await expect(composer.getByText("Some files were unsupported or exceeded the attachment limits.")).toBeVisible();
    await staged.getByRole("button", { name: "Remove remove.txt" }).click();
    const transfer = await page.evaluateHandle((encoded) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))], "pixel.png", { type: "image/png" }));
      return transfer;
    }, pixel.toString("base64"));
    await page.locator("main").dispatchEvent("drop", { dataTransfer: transfer });
    await expect(staged.getByRole("listitem")).toHaveCount(2);
    assert.equal(uploads.length, 0);
    assert.equal((await turns()).length, 0);
    await send.click();
    await expect.poll(async () => (await turns()).length, { timeout: 25_000 }).toBe(1);
    const [question] = await turns();
    const last = question.messages.at(-1);
    assert.equal(last?.content, "");
    assert.equal(last.attachments?.length, 2);
    await expect(page.getByRole("list", { name: "Attached files" })).toContainText("note.txt");
    await expect(page.getByRole("list", { name: "Attached files" })).toContainText("pixel.png");
    await expect(staged).toHaveCount(0);
    const saved = await prisma.messageAttachment.findMany({ where: { messageId: question.sourceUserMessageId }, orderBy: { ordinal: "asc" } });
    assert.deepEqual(saved.map(({ id, name }) => [id, name]), last.attachments?.map(({ attachmentId, name }) => [attachmentId, name]));
    assert.deepEqual(saved.map(({ objectKey }) => objects.get(objectKey)?.bytes), [note, pixel]);
    assert.ok(uploads.every(({ authorization }) => authorization === undefined));
    assert.ok(last.attachments?.every((entry) => !("objectKey" in entry) && !("uploadId" in entry)));

    const messageInput = composer.getByRole("textbox", { name: "Chat message" });
    await expect(messageInput).toBeEnabled();
    await messageInput.evaluate((input) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["Cancelled upload."], "cancel.txt", { type: "text/plain" }));
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await expect(staged.getByText("cancel.txt")).toBeVisible();
    await send.click();
    await expect.poll(() => uploads.some(({ path }) => path.includes("cancel.txt"))).toBe(true);
    await composer.getByRole("button", { name: "Cancel upload" }).click();
    await expect(composer.getByText("Upload cancelled.")).toBeVisible();
    await expect(staged.getByText("cancel.txt")).toBeVisible();
    assert.equal((await turns()).length, 1);
    await staged.getByRole("button", { name: "Remove cancel.txt" }).click();
    await verifyGeneratedSave(application, page, question, profile, objects);

    await page.getByRole("button", { name: "Review", exact: true }).click();
    const review = page.getByRole("form", { name: "Review composer" });
    await page.getByRole("button", { name: "Professional", exact: true }).click();
    await page.getByRole("button", { name: "Review mode and models", exact: true }).click();
    const reviewPicker = page.getByRole("dialog", { name: "Review mode and models" });
    await reviewPicker.getByRole("button", { name: /All models/ }).click();
    for (const name of ["GPT 6 Luna", "GPT-5.6 Luna"]) await reviewPicker.getByTestId("model-option").filter({ hasText: name }).click();
    await reviewPicker.getByTestId("model-picker-done").click();
    await review.locator('input[type="file"]').setInputFiles({ name: "comparison.txt", mimeType: "text/plain", buffer: note });
    await review.getByRole("textbox", { name: "Review question" }).fill("Compare using the attached note.");
    await review.getByRole("button", { name: "Send Review question" }).click();
    await expect.poll(async () => (await turns()).length, { timeout: 25_000 }).toBe(3);
    const [, first, second] = await turns();
    assert.equal(first.sourceUserMessageId, second.sourceUserMessageId);
    assert.equal(first.messages.at(-1)?.attachments?.[0]?.name, "comparison.txt");
    assert.deepEqual(first.messages.at(-1)?.attachments, second.messages.at(-1)?.attachments);
    await expect(page.getByRole("list", { name: "Attached files" }).first()).toContainText("comparison.txt");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const conversationIds = [...new Set((await turns().catch(() => [])).map(({ conversationId }) => conversationId))];
    if (conversationIds.length) await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    await prisma.$disconnect();
  }
}
