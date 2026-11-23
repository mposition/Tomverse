import { expect, test, type Page } from "@playwright/test";

const storage = "tomverse-native-synthetic-demo";
const store = `${storage}:project-workspace`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ storage }) => {
    // Seed only once, so a reload inside a test keeps what the test changed.
    if (!localStorage.getItem(storage)) localStorage.setItem(storage, JSON.stringify([]));
    localStorage.setItem(`${storage}:session`, "signed-in");
    if (!localStorage.getItem("tomverse-language")) localStorage.setItem("tomverse-language", "en");
  }, { storage });
  await page.goto("/");
});

async function openFilter(page: Page) {
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "Filter conversations", exact: true }).click();
}
async function createProject(page: Page, name: string) {
  await openFilter(page);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  return page.getByRole("dialog", { name });
}
const tab = (workspace: ReturnType<Page["getByRole"]>, name: string) => workspace.getByRole("tab", { name, exact: true }).click();
const readStore = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), store);

test("a new workspace sends context on explicitly and shows what it will and will not do", async ({ page }) => {
  const workspace = await createProject(page, "Launch plan");
  await expect(workspace.getByText("Context is on")).toBeVisible();
  expect((await readStore(page)).projects[0]).toMatchObject({ name: "Launch plan", contextEnabled: true, memoryScope: "project_only", autoMemoryEnabled: false });
  await tab(workspace, "Settings");
  await expect(workspace.getByText(/Automatic memory may not run yet/)).toBeVisible();
  await expect(workspace.getByLabel("Suggest memories from this project's conversations")).not.toBeChecked();
});

test("settings save with the opened revision, and a change made elsewhere is reported instead of overwritten", async ({ page }) => {
  const workspace = await createProject(page, "Research");
  await tab(workspace, "Settings");
  await workspace.getByLabel("Instructions (optional)").fill("Answer in short bullet points.");
  await page.evaluate(key => { const data = JSON.parse(localStorage.getItem(key)!); data.projects[0].revision += 1; localStorage.setItem(key, JSON.stringify(data)); }, store);
  await workspace.getByRole("button", { name: "Save", exact: true }).click();
  await expect(workspace.getByRole("alert")).toContainText("changed somewhere else");
  expect((await readStore(page)).projects[0].instructions).toBe("");
  await workspace.getByRole("button", { name: "Reload", exact: true }).click();
  await workspace.getByLabel("Instructions (optional)").fill("Answer in short bullet points.");
  await workspace.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await readStore(page)).projects[0].instructions).toBe("Answer in short bullet points.");
});

test("materials: note, upload, delete copy only, and a failed file offers a retry", async ({ page }) => {
  const workspace = await createProject(page, "Docs");
  await tab(workspace, "Materials");
  await expect(workspace.getByText(/separate copies owned by this project/)).toBeVisible();
  await workspace.getByRole("button", { name: "Add text note", exact: true }).click();
  await workspace.getByLabel("Note title").fill("Brief"); await workspace.getByLabel("Note text").fill("Launch is in March.");
  await workspace.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(workspace.getByText("Brief", { exact: true })).toBeVisible();
  await workspace.locator("input[type=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(workspace.getByText("notes.txt", { exact: true })).toBeVisible();
  await expect(workspace.getByText("Project copy").first()).toBeVisible();
  await page.evaluate(key => { const data = JSON.parse(localStorage.getItem(key)!); const id = data.projects[0].id; data.materials[id][1].processingStatus = "failed"; localStorage.setItem(key, JSON.stringify(data)); }, store);
  await workspace.getByRole("tab", { name: "Overview" }).click(); await tab(workspace, "Materials");
  await expect(workspace.getByText("Processing failed")).toBeVisible();
  await workspace.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(workspace.getByText("Processing failed")).toBeHidden();
  await workspace.getByRole("button", { name: "Delete", exact: true }).first().click();
  await expect(workspace.getByRole("alertdialog")).toContainText("original source is not affected");
  await workspace.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(workspace.getByText("Brief", { exact: true })).toBeHidden();
});

test("memories: add, pin, and moving to personal memory warns first", async ({ page }) => {
  const workspace = await createProject(page, "Memory test");
  await tab(workspace, "Memories");
  await expect(workspace.getByText("used only in this project")).toBeVisible();
  await workspace.getByRole("button", { name: "Add memory", exact: true }).click();
  await workspace.getByLabel("What to remember").fill("Prefers metric units");
  await workspace.getByLabel("Why it is remembered").fill("Said so in the kickoff call");
  await workspace.getByRole("button", { name: "Save", exact: true }).click();
  await expect(workspace.getByText("Prefers metric units")).toBeVisible();
  await workspace.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(workspace.getByText(/Pinned/).first()).toBeVisible();
  await workspace.getByText("Evidence").click(); await expect(workspace.getByText("Said so in the kickoff call")).toBeVisible();
  await workspace.getByRole("button", { name: "Move to personal memory", exact: true }).first().click();
  await expect(workspace.getByRole("alertdialog")).toContainText("other conversations too");
  await workspace.getByRole("alertdialog").getByRole("button", { name: "Move to personal memory" }).click();
  await expect(workspace.getByText("Prefers metric units")).toBeHidden();
});

test("delete shows what stays and what is lost, and a changed project needs a fresh confirmation", async ({ page }) => {
  const workspace = await createProject(page, "To remove");
  await tab(workspace, "Materials");
  await workspace.getByRole("button", { name: "Add text note", exact: true }).click();
  await workspace.getByLabel("Note title").fill("Keep?"); await workspace.getByLabel("Note text").fill("text");
  await workspace.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(workspace.getByText("Keep?", { exact: true })).toBeVisible();
  await tab(workspace, "Settings");
  await workspace.getByRole("button", { name: "Delete project", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "Delete project: To remove" });
  const summary = removal.getByTestId("project-delete-summary");
  await expect(summary).toContainText("Conversations that stay: 0"); await expect(summary).toContainText("Materials deleted: 1"); await expect(summary).toContainText("Memories deleted: 0");
  // Someone adds a memory while the confirmation is on screen.
  await page.evaluate(key => { const data = JSON.parse(localStorage.getItem(key)!); const id = data.projects[0].id; data.memories[id] = [{ id: "m1", kind: "preference", statement: "x", status: "active", pinned: false, revision: 1, userEdited: true, projectId: id, suspendedReason: null, expiresAt: null, evidence: [] }]; data.projects[0].revision += 1; localStorage.setItem(key, JSON.stringify(data)); }, store);
  await removal.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(removal.getByRole("alert")).toContainText("changed while you were confirming");
  await expect(summary).toContainText("Memories deleted: 1");
  expect((await readStore(page)).projects).toHaveLength(1);
  await removal.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(removal).toBeHidden();
  expect((await readStore(page)).projects).toHaveLength(0);
});

test("a project chat is created in the project, keeps the draft while sources are picked, and shows its sources", async ({ page }) => {
  const workspace = await createProject(page, "Client work");
  await tab(workspace, "Materials");
  await workspace.getByRole("button", { name: "Add text note", exact: true }).click();
  await workspace.getByLabel("Note title").fill("Pricing sheet"); await workspace.getByLabel("Note text").fill("Prices in AUD");
  await workspace.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(workspace.getByText("Pricing sheet", { exact: true })).toBeVisible();
  await workspace.getByRole("tab", { name: "Overview" }).click();
  await workspace.getByRole("button", { name: "New conversation in this project" }).click();
  await expect(workspace).toBeHidden();
  await expect(page.getByTestId("project-chat-bar")).toContainText("Project: Client work");
  const input = page.getByRole("textbox").last();
  await input.fill("Summarise the pricing");
  await page.getByRole("button", { name: "Project sources", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Project sources" });
  await picker.getByRole("searchbox").fill("Pricing"); await picker.getByRole("button", { name: "Search", exact: true }).click();
  await picker.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(picker.getByRole("button", { name: "Attached", exact: true })).toBeVisible();
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await expect(input).toHaveValue("Summarise the pricing");
  await expect(page.getByTestId("project-chat-bar")).toContainText("Sources attached to your next question: 1");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("project-receipt")).toBeVisible();
  // The created conversation belongs to the project and the attachment applies to one question only.
  expect(((await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storage)) as Array<{ projectId: string }>)[0].projectId).toBeTruthy();
  await expect(page.getByTestId("project-chat-bar")).not.toContainText("Sources attached");
  await page.getByTestId("project-receipt").click();
  const receipt = page.getByRole("dialog", { name: "Sources for this answer" });
  await expect(receipt.getByText(/does not prove the model relied/)).toBeVisible();
  await expect(receipt.getByRole("heading", { name: "Sent as context" })).toBeVisible();
  await receipt.getByRole("button", { name: "View source" }).first().click();
  await expect(receipt.getByText("Synthetic content of Pricing sheet").first()).toBeVisible();
});

test("an archived project cannot take a new turn and says how to continue", async ({ page }) => {
  const workspace = await createProject(page, "Frozen");
  await workspace.getByRole("button", { name: "New conversation in this project" }).click();
  await expect(page.getByTestId("project-chat-bar")).toContainText("Project: Frozen");
  await page.getByRole("button", { name: /Project: Frozen/ }).click();
  const reopened = page.getByRole("dialog", { name: "Frozen" });
  await tab(reopened, "Settings"); await reopened.getByRole("button", { name: "Archive project", exact: true }).click();
  await expect(reopened.getByRole("button", { name: "Restore project", exact: true })).toBeVisible();
  await reopened.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("textbox").last().fill("hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert").first()).toContainText("archived");
  await expect(page.getByRole("textbox").last()).toHaveValue("hello");
  // Ordinary Chat is untouched.
  await page.locator(".header-new-chat").click();
  await page.getByRole("textbox").last().fill("still works"); await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/This is a local demo response/)).toBeVisible();
});

test("the workspace speaks the app language", async ({ page }) => {
  // Set before the app starts: on load the app writes its current language back, which can overwrite a value set after load.
  await page.addInitScript(() => localStorage.setItem("tomverse-language", "ko")); await page.reload();
  await page.getByRole("button", { name: "대화", exact: true }).click();
  await page.getByRole("button", { name: "대화 필터", exact: true }).click();
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).click();
  await page.getByLabel("이름", { exact: true }).fill("한국어 프로젝트"); await page.getByRole("button", { name: "프로젝트 만들기", exact: true }).click();
  const workspace = page.getByRole("dialog", { name: "한국어 프로젝트" });
  await expect(workspace.getByText("맥락 사용 중")).toBeVisible();
  await tab(workspace, "설정");
  await expect(workspace.getByText(/자동 기억은 아직 동작하지 않을 수 있습니다/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a personal memory can be brought into the project after a warning, and a same-topic conflict is refused", async ({ page }) => {
  const workspace = await createProject(page, "Import target");
  await tab(workspace, "Memories");
  const seed = (statement: string) => page.evaluate(({ key, statement }) => {
    const data = JSON.parse(localStorage.getItem(key)!); const id = data.projects[0].id;
    data.memories.__personal = [...(data.memories.__personal ?? []), { id: `p-${statement}`, kind: "preference", statement, status: "active", pinned: false, revision: 3, userEdited: true, projectId: null, suspendedReason: null, expiresAt: null, evidence: [] }];
    localStorage.setItem(key, JSON.stringify(data)); return id;
  }, { key: store, statement });
  await seed("Likes short answers"); await seed("Uses metric units");
  await workspace.getByRole("button", { name: "Bring in a personal memory", exact: true }).click();
  const panel = workspace.getByTestId("personal-memory-import");
  await expect(panel.getByText("Likes short answers")).toBeVisible();
  await panel.getByRole("button", { name: "Move to this project" }).first().click();
  await expect(panel.getByRole("alertdialog")).toContainText("no longer used in your other conversations");
  await panel.getByRole("alertdialog").getByRole("button", { name: "Move to this project" }).click();
  await expect(workspace.getByText("Likes short answers")).toHaveCount(1);
  await expect(panel.getByText("Likes short answers")).toBeHidden();
  expect((await readStore(page)).memories.__personal).toHaveLength(1);
  // The same topic already lives in the project: the move is refused and nothing changes.
  await page.evaluate(key => { const data = JSON.parse(localStorage.getItem(key)!); const id = data.projects[0].id; data.memories[id].push({ ...data.memories.__personal[0], id: "dup" }); localStorage.setItem(key, JSON.stringify(data)); }, store);
  await workspace.getByRole("tab", { name: "Overview" }).click(); await tab(workspace, "Memories");
  await workspace.getByRole("button", { name: "Bring in a personal memory", exact: true }).click();
  await panel.getByRole("button", { name: "Move to this project" }).first().click();
  await panel.getByRole("alertdialog").getByRole("button", { name: "Move to this project" }).click();
  await expect(panel.getByRole("alert")).toContainText("already holds an active memory on the same topic");
  expect((await readStore(page)).memories.__personal).toHaveLength(1);
});

test("when the server reports the workspace as off, folders keep working and a project chat cannot be sent", async ({ page }) => {
  await page.evaluate(({ storage }) => {
    localStorage.setItem(`${storage}:projects-unavailable`, "1");
    localStorage.setItem(`${storage}:project-workspace`, JSON.stringify({ projects: [{ id: "work", name: "Work", description: "", instructions: "", contextEnabled: true, memoryScope: "project_only", autoMemoryEnabled: false, revision: 1, archivedAt: null, updatedAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z" }], materials: {}, memories: {}, receipts: {} }));
    localStorage.setItem(storage, JSON.stringify([{ id: "c1", title: "Web project chat", selectedModels: ["demo"], projectId: "work", messages: [] }]));
  }, { storage });
  await page.reload();
  await openFilter(page);
  await expect(page.getByRole("button", { name: "Open project: Work" })).toHaveCount(0);
  await expect(page.getByText(/not available yet/)).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill("Plain folder"); await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Plain folder" })).toHaveCount(0);
  await page.getByRole("button", { name: "Filter conversations" }).click(); await expect(page.getByRole("button", { name: "Rename project: Plain folder" })).toBeVisible();
  await page.getByRole("dialog").last().getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Web project chat", exact: true }).click();
  await expect(page.getByTestId("project-chat-bar")).toContainText("Project:");
  await expect(page.getByRole("button", { name: /Project:/ })).toHaveCount(0);
  await page.getByRole("textbox").last().fill("hello"); await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert").first()).toContainText("unavailable");
  await expect(page.getByRole("textbox").last()).toHaveValue("hello");
});
