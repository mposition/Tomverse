import { expect, test } from "@playwright/test";
import { selectProduct } from "./workspaceNavigation";

const storage = "tomverse-native-synthetic-demo";
const question = "Use the second option. " + "Keep all those conditions. ".repeat(60);
const parent = {
  id: "parent", title: "Context handoff parent", surface: "continuation", productKey: "chat", selectedModels: ["demo"], selectionMode: "manual",
  messages: [
    { id: "q1", role: "user", content: "Give me two options." },
    { id: "a1", role: "assistant", content: "First: Osaka. Second: Kyoto, AUD 1,500.", status: "normal", modelId: "demo" },
    { id: "q2", role: "user", content: question },
    { id: "a2", role: "assistant", content: "Clicked answer must not become a reference.", status: "normal", modelId: "demo" },
  ],
  imported: { provider: "chatgpt", importedAt: "2026-11-15T00:00:00.000Z", status: "available", offset: 0, pageSize: 100,
    messages: [{ id: "external-one", ordinal: 0, role: "user", content: "Kyoto with AUD 1,500.", sourceModelLabel: null }] },
};
test.beforeEach(async ({ page }) => {
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.addInitScript(({ storage, parent }) => {
    if (!localStorage.getItem(storage)) localStorage.setItem(storage, JSON.stringify([parent]));
    localStorage.setItem(`${storage}:session`, "signed-in"); localStorage.setItem("tomverse-language", "en");
  }, { storage, parent });
  await page.goto("/");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.locator(".conversation-row", { hasText: parent.title }).click();
});

test("continuation Compare opens a bound long draft, preserves other drafts, reloads edits, and consumes only on Send", async ({ page }) => {
  await page.locator("textarea").fill("Unsent parent question");
  await page.getByTestId("file-picker").setInputFiles({ name: "unsent.txt", mimeType: "text/plain", buffer: Buffer.from("An unsent attachment") });
  await expect(page.locator(".attachments")).toContainText("unsent.txt");
  await selectProduct(page, "review");
  await page.locator(".review-workspace textarea").fill("Existing general Review draft");
  await selectProduct(page, "chat");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.locator(".conversation-row", { hasText: parent.title }).click();
  await expect(page.locator("textarea")).toHaveValue("Unsent parent question");
  await expect(page.locator(".attachments")).toContainText("unsent.txt");
  await page.getByTestId("chat-compare-in-review").last().click();
  const draft = page.locator(".review-workspace textarea");
  await expect(draft).toHaveValue(question);
  await expect(page.getByTestId("review-handoff-context")).toContainText("selected answer is excluded");
  await expect(page.getByTestId("review-handoff-context")).toContainText("This answer has no recorded source excerpts");
  const target = await page.evaluate(storage => JSON.parse(localStorage.getItem(storage)!).find((row: { productKey?: string }) => row.productKey === "review"), storage);
  expect(target.messages).toEqual([]);
  expect(JSON.stringify(target)).not.toContain("Kyoto with AUD 1,500");
  expect(JSON.stringify(target)).not.toContain("Second: Kyoto");
  await draft.fill("Edited independent question");
  await expect.poll(() => page.evaluate(({ storage, id }) => JSON.parse(localStorage.getItem(`${storage}:handoff-drafts`) ?? "{}")[id]?.text, { storage, id: target.id })).toBe("Edited independent question");
  await page.reload();
  await expect(draft).toHaveValue("Edited independent question");
  await page.getByRole("button", { name: /Professional/ }).click();
  await page.getByRole("checkbox", { name: /Local demo A/ }).check();
  await page.getByRole("checkbox", { name: /Local demo B/ }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".review-workspace .message.assistant")).toHaveCount(1);
  await expect(draft).toHaveValue("");
  await expect.poll(() => page.evaluate(({ storage, id }) => JSON.parse(localStorage.getItem(`${storage}:handoff-drafts`) ?? "{}")[id] ?? null, { storage, id: target.id })).toBeNull();
  await page.reload();
  await expect(draft).toHaveValue("");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(draft).toHaveValue("Existing general Review draft");
});

test("a lost answer A acknowledgement never supplies its key or target to answer B", async ({ page }) => {
  await page.evaluate(storage => localStorage.setItem(`${storage}:handoff-fail-once`, JSON.stringify(["a1"])), storage);
  await page.getByTestId("chat-compare-in-review").first().click();
  await expect(page.getByRole("alert")).toContainText("could not be prepared");
  await page.getByTestId("chat-compare-in-review").last().click();
  await expect(page.locator(".review-workspace textarea")).toHaveValue(question);
  const attempts = await page.evaluate(storage => Object.values(JSON.parse(localStorage.getItem(`${storage}:handoffs`) ?? "{}")) as Array<{ assistantId: string; conversationId: string }>, storage);
  expect(attempts).toHaveLength(2);
  expect(new Set(attempts.map(row => row.conversationId)).size).toBe(2);
  expect(attempts.map(row => row.assistantId)).toEqual(["a1", "a2"]);
});

test("same-answer retry reuses its target and attachments never fall back to a plain question", async ({ page }) => {
  await page.evaluate(storage => localStorage.setItem(`${storage}:handoff-fail-once`, JSON.stringify(["a2"])), storage);
  await page.getByTestId("chat-compare-in-review").last().click();
  await expect(page.getByRole("alert")).toContainText("could not be prepared");
  await page.getByTestId("chat-compare-in-review").last().click();
  await expect(page.locator(".review-workspace textarea")).toHaveValue(question);
  expect(await page.evaluate(storage => Object.keys(JSON.parse(localStorage.getItem(`${storage}:handoffs`) ?? "{}")).length, storage)).toBe(1);
  await selectProduct(page, "chat");
  await page.evaluate(storage => {
    const rows = JSON.parse(localStorage.getItem(storage)!);
    rows.find((row: { id: string }) => row.id === "parent").messages[2].attachments = [{ id: "file", name: "conditions.pdf", kind: "file" }];
    localStorage.setItem(storage, JSON.stringify(rows));
  }, storage);
  await page.getByTestId("chat-compare-in-review").last().click();
  await expect(page.getByRole("alert")).toContainText("attachments are not supported");
  await expect(page.locator(".review-workspace")).toHaveCount(0);
});

test("a draft conflict preserves local edits and blocks navigation until explicit saved-draft readback", async ({ page }) => {
  await page.getByTestId("chat-compare-in-review").last().click();
  const draft = page.locator(".review-workspace textarea");
  await expect(draft).toHaveValue(question);
  await page.evaluate(storage => {
    const drafts = JSON.parse(localStorage.getItem(`${storage}:handoff-drafts`)!);
    const id = Object.keys(drafts)[0]; drafts[id].text = "Edited on another device"; drafts[id].revision++;
    localStorage.setItem(`${storage}:handoff-drafts`, JSON.stringify(drafts));
  }, storage);
  await draft.fill("My unsaved edit");
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(draft).toHaveValue("My unsaved edit");
  await expect(page.locator(".workspace-navigation").getByRole("button", { name: "Chat", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Load saved draft", exact: true }).click();
  await expect(draft).toHaveValue("Edited on another device");
});

test("an unknown send never recreates its consumed question and is resolved by readback", async ({ page }) => {
  await page.getByTestId("chat-compare-in-review").last().click();
  const draft = page.locator(".review-workspace textarea");
  await expect(draft).toHaveValue(question);
  await page.getByRole("button", { name: /Professional/ }).click();
  await page.getByRole("checkbox", { name: /Local demo A/ }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.evaluate(storage => localStorage.setItem(`${storage}:review-send-unknown`, "true"), storage);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".review-workspace .restore")).toBeVisible();
  await expect(page.locator(".workspace-navigation").getByRole("button", { name: "Chat", exact: true })).toBeDisabled();
  await page.locator(".review-workspace .restore").click();
  await expect(draft).toHaveValue("");
  const target = await page.evaluate(storage => JSON.parse(localStorage.getItem(storage)!).find((row: { productKey?: string }) => row.productKey === "review"), storage);
  expect(target.messages).toHaveLength(1);
  expect(target.messages[0].role).toBe("user");
  await page.reload();
  await expect(draft).toHaveValue("");
});

test("an oversized saved question shows the explicit Review input limit without a lossy fallback", async ({ page }) => {
  await page.evaluate(storage => {
    const rows = JSON.parse(localStorage.getItem(storage)!);
    rows.find((row: { id: string }) => row.id === "parent").messages[2].content = "x".repeat(50_001);
    localStorage.setItem(storage, JSON.stringify(rows));
  }, storage);
  await page.getByTestId("chat-compare-in-review").last().click();
  await expect(page.getByRole("alert")).toContainText("50,000 character input limit");
  await expect(page.locator(".review-workspace")).toHaveCount(0);
  expect(await page.evaluate(storage => localStorage.getItem(`${storage}:handoffs`), storage)).toBeNull();
});

test("an unsupported saved mode shows the text-only boundary without a lossy fallback", async ({ page }) => {
  await page.evaluate(storage => {
    const rows = JSON.parse(localStorage.getItem(storage)!);
    rows.find((row: { id: string }) => row.id === "parent").messages[3].researchRunId = "synthetic-research";
    localStorage.setItem(storage, JSON.stringify(rows));
  }, storage);
  await page.getByTestId("chat-compare-in-review").last().click();
  await expect(page.getByRole("alert")).toContainText("Research and images are not supported");
  await expect(page.locator(".review-workspace")).toHaveCount(0);
  expect(await page.evaluate(storage => localStorage.getItem(`${storage}:handoffs`), storage)).toBeNull();
});
