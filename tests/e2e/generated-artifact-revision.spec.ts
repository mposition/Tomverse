import { expect, test, type Page, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { finalizedUploadRegistry, mockAttachmentUpload, mockAuthenticatedApi, openRecentConversation } from "./support/app-fixtures";
import { buildChatStreamTrailerChunk } from "@/lib/webSearchStreamTrailer";
import { artifactFormat, type ChatStreamArtifact } from "@/lib/generatedArtifactCore";

const source = (id: string, format = "md"): ChatStreamArtifact => ({
  id, ordinal: 0, format, filename: `report.${format}`, mediaType: artifactFormat(format)?.mediaType ?? "application/octet-stream",
  byteSize: 30, status: "ready", modelId: "gpt-6-luna",
});
const cards = (page: Page) => page.getByTestId("generated-artifact-card");
const input = (page: Page) => page.getByTestId("chat-textarea");
const copyIds = new WeakMap<Page, Map<string, string>>();
function opaqueCopyId(page: Page, artifactId: string) {
  const ids = copyIds.get(page) ?? new Map<string, string>();
  copyIds.set(page, ids);
  const id = ids.get(artifactId) ?? randomUUID();
  ids.set(artifactId, id);
  return id;
}

async function open(page: Page, enabled = true, formats = ["md", "md"]) {
  await mockAuthenticatedApi(page, { productKey: "chat", language: "en", selectedModels: ["gpt-6-luna"],
    messages: formats.flatMap((format, i) => [
      { id: `u-${i}`, role: "user" as const, content: `Make report ${i}` },
      { id: `a-${i}`, role: "assistant" as const, content: `Created report ${i}`,
        modelId: "gpt-6-luna", artifacts: [source(`artifact-${i}`, format)] },
    ]) });
  if (enabled) await page.context().addCookies([{ name: "__tomverse_e2e_artifact_revision", value: "1", url: "http://127.0.0.1:3100" }]);
  await page.goto("/chat?lang=en");
  await openRecentConversation(page);
  await expect(cards(page)).toHaveCount(formats.length);
}

async function copied(page: Page, route: Route, artifactId: string) {
  const uploadId = opaqueCopyId(page, artifactId);
  const upload = { name: "report.md", mediaType: "text/markdown", size: 30, kind: "text" as const };
  finalizedUploadRegistry(page).set(uploadId, upload);
  await route.fulfill({ status: 200, json: { uploadId, ...upload } });
}

test("the server revision switch governs entry and keeps existing downloads available", async ({ page }) => {
  await open(page, false);
  await expect(page.getByTestId("generated-artifact-revise")).toHaveCount((process.env.E2E_GENERATED_ARTIFACT_REVISION_ENABLED ?? "true") === "true" ? 2 : 0);
  await expect(page.getByTestId("generated-artifact-download")).toHaveCount(2);
});

test("an older same-name card selects its exact id and preserves text typed during preparation @ui-risk", async ({ page }) => {
  await open(page);
  let pending: Route | null = null;
  const requests: Array<Record<string, string>> = [];
  let posts = 0;
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PUT") {
      requests.push(route.request().postDataJSON()); pending = route; return;
    }
    if (route.request().method() === "POST") posts++;
    await route.fallback();
  });
  await input(page).fill("Existing request");
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ action: "generated-artifact-copy", artifactId: "artifact-0", conversationId: "qa-conversation" });
  expect(requests[0].operationId).toBeTruthy();
  await input(page).fill("Existing request plus typing while preparing");
  await copied(page, pending!, "artifact-0");
  await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
  await expect(input(page)).toHaveValue("Create a new file from the attached report.md with the changes below. Keep the original file.\n\nExisting request plus typing while preparing");
  expect(posts).toBe(0);
  await cards(page).last().getByTestId("generated-artifact-revise").click();
  await expect(cards(page).last().getByTestId("generated-artifact-revision-error")).toContainText("already attached");
  expect(requests).toHaveLength(1);
});

test("failed preparation preserves the draft and a retry reuses the operation id", async ({ page }) => {
  await open(page);
  const operations: string[] = [];
  await page.route("**/api/chat", async route => {
    if (route.request().method() !== "PUT") return route.fallback();
    operations.push(route.request().postDataJSON().operationId);
    if (operations.length === 1) return route.fulfill({ status: 503, json: { code: "ATTACHMENT_STORAGE_UNAVAILABLE" } });
    return copied(page, route, "artifact-0");
  });
  await input(page).fill("Keep these words");
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect(cards(page).first().getByTestId("generated-artifact-revision-error")).toBeVisible();
  await expect(input(page)).toHaveValue("Keep these words");
  await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
  expect(operations).toHaveLength(2);
  expect(operations[0]).toBe(operations[1]);
});

test("late preparation stays in its original conversation draft @ui-risk", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The desktop sidebar drives the scope transition.");
  await open(page);
  let pending: Route | null = null;
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PUT") { pending = route; return; }
    await route.fallback();
  });
  await input(page).fill("Original conversation draft");
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect.poll(() => pending !== null).toBe(true);
  await page.getByTestId("sidebar-new-chat").click();
  await input(page).fill("Different conversation draft");
  await copied(page, pending!, "artifact-0");
  await expect(input(page)).toHaveValue("Different conversation draft");
  await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
  await openRecentConversation(page);
  await expect(input(page)).toHaveValue(/Create a new file.*\n\nOriginal conversation draft/);
  await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
});

test("files added during preparation keep the ten-file limit and reclaim only the unused copy", async ({ page }) => {
  await open(page);
  await mockAttachmentUpload(page);
  let pending: Route | null = null;
  const removed: string[] = [];
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PUT" && route.request().postDataJSON().action === "generated-artifact-copy") {
      pending = route; return;
    }
    if (route.request().method() === "DELETE") {
      removed.push(route.request().postDataJSON().uploadId);
      await route.fulfill({ status: 204, body: "" }); return;
    }
    await route.fallback();
  });
  await input(page).fill("Keep this text");
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect.poll(() => pending !== null).toBe(true);
  await page.locator('input[type="file"]').first().setInputFiles(Array.from({ length: 10 }, (_, i) => ({
    name: `notes-${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`Notes ${i}`),
  })));
  await expect(page.getByTestId("attachment-complete")).toHaveCount(10);
  await copied(page, pending!, "artifact-0");
  await expect(cards(page).first().getByTestId("generated-artifact-revision-error")).toContainText("up to 10 files");
  await expect(input(page)).toHaveValue("Keep this text");
  await expect(page.getByTestId("attachment-complete")).toHaveCount(10);
  expect(removed).toEqual([opaqueCopyId(page, "artifact-0")]);
});

test("the ordinary draft reloads and Send carries exactly the visible request and copied upload @ui-risk", async ({ page }) => {
  await open(page);
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PUT") return copied(page, route, "artifact-0");
    await route.fallback();
  });
  await input(page).fill("Shorten the second paragraph");
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
  const visible = await input(page).inputValue();
  await expect.poll(async () => {
    const data = await page.evaluate(async () => (await fetch("/api/products/chat/drafts/qa-conversation")).json());
    return data.draft?.text;
  }).toBe(visible);
  // A new document drops all client state. The fake conversation id has no
  // server-side DB row, so reopen the app entry and restore the stored scope.
  await page.goto("/chat?lang=en");
  await expect(input(page)).toBeVisible();
  // A returning mobile conversation already has a header drawer button,
  // while a fresh welcome has the recent-conversations disclosure instead.
  const drawerButton = page.getByTestId("mobile-sidebar-open");
  if (await drawerButton.isVisible()) {
    await drawerButton.click();
    await page.locator('[data-testid="sidebar-conversation-item"][data-conversation-id="qa-conversation"]').click();
  } else {
    await openRecentConversation(page);
  }
  await expect(input(page)).toHaveValue(visible);
  await expect(page.getByTestId("attachment-complete")).toContainText("report.md");
  let sent: Record<string, unknown> | null = null;
  await page.route("**/api/chat", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "Here is a suggestion." +
      buildChatStreamTrailerChunk({ searchMetadata: null, completion: { status: "normal" } }) });
  });
  await page.getByTestId("chat-send-button").click();
  await expect.poll(() => sent !== null).toBe(true);
  const messages = (sent as unknown as { messages: Array<{
    role: string; content: string;
    attachments?: Array<{ id: string; attachmentId?: string; uploadId?: string }>;
  }> }).messages;
  const latestUser = messages.filter(message => message.role === "user").at(-1)!;
  expect(latestUser.content).toBe(visible);
  expect(latestUser.attachments).toMatchObject([{ id: opaqueCopyId(page, "artifact-0"), attachmentId: expect.stringMatching(/^ma-/) }]);
  expect(latestUser.attachments![0]).not.toHaveProperty("uploadId");
  expect(JSON.stringify(sent)).not.toContain("artifact-0");
  // A text-only reply creates no new file card and is not revision success.
  await expect(cards(page)).toHaveCount(2);
});

test("an account switch never receives another person's late revision input @ui-risk", async ({ page }) => {
  await open(page);
  const session = { id: "qa-user", reads: 0 };
  await page.route("**/api/auth/session**", route => {
    session.reads++;
    return route.fulfill({ json: { user: { id: session.id, name: session.id,
      email: `${session.id}@example.test`, image: null, plan: "Free" }, expires: "2099-01-01T00:00:00.000Z" } });
  });
  let pending: Route | null = null;
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PUT") { pending = route; return; }
    await route.fallback();
  });
  await input(page).fill("Account A draft");
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect.poll(() => pending !== null).toBe(true);
  session.id = "qa-user-2";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(input(page)).toHaveValue("");
  await input(page).fill("Account B draft");
  await copied(page, pending!, "artifact-0");
  await expect(input(page)).toHaveValue("Account B draft");
  await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
  session.id = "qa-user";
  const beforeReturn = session.reads;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => session.reads).toBeGreaterThan(beforeReturn);
  await openRecentConversation(page);
  await expect(input(page)).toHaveValue(/Create a new file.*\n\nAccount A draft/);
  await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
});

test("a failed revision response preserves a newer draft and the saved source attachment for retry @ui-risk", async ({ page }) => {
  await open(page);
  let pending: Route | null = null;
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PUT") return copied(page, route, "artifact-0");
    if (route.request().method() === "POST") { pending = route; return; }
    await route.fallback();
  });
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
  const submittedText = await input(page).inputValue();
  await page.getByTestId("chat-send-button").click();
  await expect.poll(() => pending !== null).toBe(true);
  await expect(input(page)).toHaveValue("");
  await input(page).fill("New work typed while the revision response is pending");
  await pending!.fulfill({ status: 500, json: { error: "The response could not be completed.", code: "PROVIDER_ERROR" } });
  await expect(page.getByTestId("chat-error-icon")).toBeVisible();
  await expect(input(page)).toHaveValue("New work typed while the revision response is pending");
  await expect(page.locator('[data-message-role="user"]').filter({ hasText: submittedText })).toContainText("report.md");
  const saved = await page.evaluate(async () => (await fetch("/api/conversations/qa-conversation")).json());
  const question = saved.messages.filter((message: { role: string }) => message.role === "user").at(-1);
  expect(question.content).toBe(submittedText);
  expect(question.attachments).toMatchObject([{ name: "report.md", attachmentId: expect.stringMatching(/^ma-/) }]);
  await expect(cards(page)).toHaveCount(2);
  await expect(page.locator('[data-testid="generated-artifact-card"][data-artifact-status="failed"]')).toHaveCount(0);
});

test("Office offers text rewriting with its limit and PDF keeps download only", async ({ page }) => {
  await open(page, true, ["docx", "pdf"]);
  await expect(cards(page).first().getByTestId("generated-artifact-revise")).toBeVisible();
  await expect(cards(page).first().getByTestId("generated-artifact-revision-office-notice")).toContainText("extracted text");
  await expect(cards(page).last().getByTestId("generated-artifact-revise")).toHaveCount(0);
  await expect(cards(page).last().getByTestId("generated-artifact-download")).toBeVisible();
});

test("two explicit revision sends keep the original and both new downloadable results @ui-risk", async ({ page }) => {
  await open(page);
  const selected: string[] = [];
  let sends = 0;
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      selected.push(body.artifactId);
      return copied(page, route, body.artifactId);
    }
    if (route.request().method() !== "POST") return route.fallback();
    sends++;
    const artifact = source(`revision-${sends}`);
    await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8",
      body: "Created the revised file." + buildChatStreamTrailerChunk({
        searchMetadata: null, completion: { status: "normal" }, artifacts: [artifact],
      }) });
  });
  // The first choice is deliberately an older result with a same-name sibling.
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  for (let cycle = 1; cycle <= 2; cycle++) {
    await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
    await input(page).fill(`${await input(page).inputValue()}\nShorten paragraph ${cycle}.`);
    await page.getByTestId("chat-send-button").click();
    await expect.poll(() => sends).toBe(cycle);
    await expect(cards(page)).toHaveCount(2 + cycle);
    await expect(page.getByTestId("generated-artifact-download")).toHaveCount(2 + cycle);
    await expect(page.getByTestId("attachment-complete")).toHaveCount(0);
    if (cycle === 1) await cards(page).last().getByTestId("generated-artifact-revise").click();
  }
  expect(selected).toEqual(["artifact-0", "revision-1"]);
  await expect(cards(page).first()).toContainText("report.md");
});

test("real same-name branches paginate, point to their exact parent and prepare the chosen older version @ui-risk", async ({ page }) => {
  await open(page, true, ["md"]);
  const version = (id: string, parentArtifactId: string | null, createdAt: string) => ({
    ...source(id), parentArtifactId, lineageId: "artifact-0", createdAt,
  });
  let selected = "";
  const versionsReads: string[] = [];
  await page.route("**/api/artifacts/artifact-0/versions**", async route => {
    versionsReads.push(route.request().url());
    return route.fulfill({ json: route.request().url().includes("cursor=")
      ? { artifacts: [version("artifact-0", null, "2026-11-14T00:00:00.000Z")], nextCursor: null }
      : { artifacts: [version("branch-b", "artifact-0", "2026-11-15T02:00:00.000Z"),
        version("branch-a", "artifact-0", "2026-11-15T01:00:00.000Z")], nextCursor: "older-page" } });
  });
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PUT") {
      selected = route.request().postDataJSON().artifactId;
      return copied(page, route, selected);
    }
    await route.fallback();
  });
  await input(page).fill("Keep my current request");
  await cards(page).first().getByTestId("generated-artifact-versions-toggle").click();
  const rows = page.getByTestId("generated-artifact-version");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-parent-artifact-id", "artifact-0");
  await expect(rows.nth(1)).toHaveAttribute("data-parent-artifact-id", "artifact-0");
  await cards(page).first().getByRole("button", { name: "Load earlier versions", exact: true }).click();
  await expect(rows).toHaveCount(3);
  expect(versionsReads[1]).toContain("cursor=older-page");
  const branch = rows.nth(1);
  await branch.getByTestId("generated-artifact-version-parent").click();
  await expect(rows.nth(2)).toBeFocused();
  await branch.getByTestId("generated-artifact-version-revise").click();
  await expect.poll(() => selected).toBe("branch-a");
  await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
  await expect(input(page)).toHaveValue(/Create a new file.*\n\nKeep my current request/);
});

test("a locked version history preserves the draft and never exposes server metadata", async ({ page }) => {
  await open(page, true, ["md"]);
  await page.route("**/api/artifacts/artifact-0/versions**", route => route.fulfill({
    status: 423, json: { code: "CONVERSATION_LOCKED", objectKey: "private/source" },
  }));
  await input(page).fill("Unchanged draft");
  await cards(page).first().getByTestId("generated-artifact-versions-toggle").click();
  await expect(page.getByTestId("generated-artifact-versions-error")).toContainText("Unlock");
  await expect(page.getByTestId("generated-artifact-version")).toHaveCount(0);
  await expect(input(page)).toHaveValue("Unchanged draft");
  await expect(cards(page).first()).not.toContainText("private/source");
});

for (const revisionMode of ["workbook", "workbook-values"]) {
  test(`${revisionMode} XLSX input adds a visible structure-preserving request with the correct layout limitation`, async ({ page }) => {
    await open(page, true, ["xlsx"]);
    await page.route("**/api/chat", async route => {
      if (route.request().method() !== "PUT") return route.fallback();
      expect(route.request().postDataJSON().artifactId).toBe("artifact-0");
      const upload = { name: "report.xlsx", mediaType: source("unused", "xlsx").mediaType, size: 30, kind: "file" as const };
      finalizedUploadRegistry(page).set("opaque-workbook-copy", upload);
      await route.fulfill({ json: { uploadId: "opaque-workbook-copy", ...upload, revisionMode } });
    });
    await input(page).fill("Change the amount to 42");
    await cards(page).first().getByTestId("generated-artifact-revise").click();
    await expect(page.getByTestId("attachment-complete")).toContainText("report.xlsx");
    await expect(input(page)).toHaveValue(/Create a new Excel workbook.*\n\nChange the amount to 42/);
    const visible = await input(page).inputValue();
    expect(visible).toContain(revisionMode === "workbook-values"
      ? "Column widths and display layout may change" : "Preserve the workbook structure and unchanged cells");
  });
}

test("ordinary uploads finishing after a prepared revision cannot create an eleventh chip @ui-risk", async ({ page }) => {
  await open(page, true, ["md"]);
  await mockAttachmentUpload(page);
  let sourcePending: Route | null = null;
  let uploadPending: Route | null = null;
  const removed: string[] = [];
  await page.route("**/api/chat", async route => {
    const method = route.request().method();
    if (method === "PUT" && route.request().postDataJSON().action === "generated-artifact-copy") {
      sourcePending = route; return;
    }
    if (method === "PATCH" && !uploadPending) { uploadPending = route; return; }
    if (method === "DELETE") removed.push(route.request().postDataJSON().uploadId);
    await route.fallback();
  });
  await input(page).fill("Keep this request");
  await cards(page).first().getByTestId("generated-artifact-revise").click();
  await expect.poll(() => sourcePending !== null).toBe(true);
  await page.locator('input[type="file"]').first().setInputFiles(Array.from({ length: 10 }, (_, i) => ({
    name: `late-${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`Late file ${i}`),
  })));
  await expect.poll(() => uploadPending !== null).toBe(true);
  await copied(page, sourcePending!, "artifact-0");
  await expect(page.getByTestId("attachment-complete").filter({ hasText: "report.md" })).toHaveCount(1);
  await uploadPending!.fallback();
  await expect.poll(() => removed.length).toBe(1);
  await expect(page.getByTestId("attachment-complete")).toHaveCount(10);
  await expect(page.getByTestId("attachment-complete").filter({ hasText: "report.md" })).toHaveCount(1);
  await expect(page.getByTestId("attachment-complete").filter({ hasText: "late-9.txt" })).toHaveCount(0);
  expect(removed[0]).not.toBe(opaqueCopyId(page, "artifact-0"));
  await expect(input(page)).toHaveValue(/Create a new file.*\n\nKeep this request/);
});
