import { expect, test, type Page } from "@playwright/test";

const storage = "tomverse-native-synthetic-demo";
const artifact = (id: string, parentArtifactId: string | null, format = "md") => ({
  id, ordinal: 0, format, filename: `report.${format}`, mediaType: format === "md" ? "text/markdown"
    : format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  byteSize: 30, status: "ready", modelId: "demo", lineageId: "source-old", parentArtifactId,
  createdAt: parentArtifactId ? "2026-11-15T01:00:00Z" : "2026-11-15T00:00:00Z",
});
const input = (page: Page) => page.getByRole("textbox");
const cards = (page: Page) => page.locator(".generated-file");
type Fixture = { enabled: boolean; hold: boolean; release?: () => void; fails: number; calls: Array<{ artifactId: string; conversationId: string; operationId: string }>;
  removed: string[]; sends: Array<{ text: string; uploads: string[] }>; owner: string; lose?: () => void; values: boolean; paged: boolean;
  uploadHold: boolean; uploadStarted: boolean; releaseUpload?: () => void; holdSend: boolean; releaseSend?: () => void; textOnly: boolean };

async function openConversation(page: Page, name = "Revision source", label = "Conversations") {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.locator(".conversation-row").filter({ hasText: name }).click();
  await expect(input(page)).toBeEnabled();
}
async function open(page: Page, options: { enabled?: boolean; formats?: string[]; language?: "en" | "ko" } = {}) {
  const formats = options.formats ?? ["md", "md"];
  const rows = [{ id: "source-chat", title: "Revision source", selectedModels: ["demo"], surface: "chat", messages: formats.flatMap((format, index) => [
    { id: `user-${index}`, role: "user", content: "Create a file" },
    { id: `answer-${index}`, role: "assistant", content: "Created a file", modelId: "demo", artifacts: [artifact(index === 0 ? "source-old" : "source-new", index === 0 ? null : "source-old", format)] },
  ]) }, { id: "other-chat", title: "Other conversation", selectedModels: ["demo"], surface: "chat", messages: [] }];
  await page.addInitScript(({ storage, rows, enabled, language }) => {
    if (!localStorage.getItem(storage)) localStorage.setItem(storage, JSON.stringify(rows));
    localStorage.setItem(storage + ":session", "signed-in"); localStorage.setItem("tomverse-language", language);
    (window as unknown as { revisionEnabled: boolean }).revisionEnabled = enabled;
  }, { storage, rows, enabled: options.enabled !== false, language: options.language ?? "en" });
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/src/main.tsx*", async route => {
    const response = await route.fetch();
    const fixture = `
      const storeKey=${JSON.stringify(storage)};
      const fixture=window.artifactRevisionFixture={enabled:window.revisionEnabled,hold:false,fails:0,calls:[],removed:[],sends:[],owner:'synthetic-demo',values:false,paged:false,uploadHold:false,uploadStarted:false,holdSend:false,textOnly:false};
      const capabilities=transport.mobileCapabilities;
      transport.mobileCapabilities=async()=>({...await capabilities(),generatedFileRevisions:fixture.enabled});
      const account=transport.account;transport.account=async()=>({...await account(),id:fixture.owner});
      transport.onSessionLost=listener=>{fixture.lose=listener;return()=>{}};
      const uploads=new Map();const sources=new Map(JSON.parse(localStorage.getItem(storeKey+':revision-inputs')||'[]'));
      transport.prepareArtifactRevision=async selected=>{
        fixture.calls.push(selected);
        if(fixture.hold)await new Promise(resolve=>fixture.release=resolve);
        if(fixture.fails>0){fixture.fails--;throw {status:503,code:'ATTACHMENT_STORAGE_UNAVAILABLE'}};
        const source=JSON.parse(localStorage.getItem(storeKey)).find(row=>row.id===selected.conversationId)?.messages.flatMap(message=>message.artifacts||[]).find(file=>file.id===selected.artifactId);
        if(!source)throw Error('Missing exact source');
        const uploadId=uploads.get(selected.operationId)||crypto.randomUUID();uploads.set(selected.operationId,uploadId);sources.set(uploadId,source);localStorage.setItem(storeKey+':revision-inputs',JSON.stringify([...sources]));
        return {uploadId,name:source.filename,mediaType:source.mediaType,size:source.byteSize,...(source.format==='xlsx'?{revisionMode:fixture.values?'workbook-values':'workbook'}:{})};
      };
      transport.discardAttachment=async id=>{fixture.removed.push(id)};
      const upload=transport.upload;transport.upload=async file=>{fixture.uploadStarted=true;if(fixture.uploadHold)await new Promise(resolve=>fixture.releaseUpload=resolve);return upload(file)};
      transport.artifactVersions=async(id,cursor)=>{
        const all=JSON.parse(localStorage.getItem(storeKey)).flatMap(row=>row.messages.flatMap(message=>message.artifacts||[]));
        const source=all.find(file=>file.id===id);
        const group=all.filter(file=>file.lineageId===source.lineageId).reverse();
        return fixture.paged?{artifacts:cursor?group.slice(1):group.slice(0,1),nextCursor:cursor?null:'source-new'}:{artifacts:group,nextCursor:null};
      };
      const send=transport.send;
      transport.send=async(conversation,text,files,signal,progress)=>{
        fixture.sends.push({text,uploads:files.map(file=>file.uploadId)});
        if(fixture.holdSend)await new Promise(resolve=>fixture.releaseSend=resolve);
        await send(conversation,text,files,signal,progress);
        const rows=JSON.parse(localStorage.getItem(storeKey)),row=rows.find(row=>row.id===conversation.id),answer=row.messages.at(-1),source=sources.get(files[0]?.uploadId);
        if(source&&!fixture.textOnly)answer.artifacts=[{...source,id:'revision-'+fixture.sends.length,parentArtifactId:source.id,createdAt:new Date().toISOString()}];
        localStorage.setItem(storeKey,JSON.stringify(rows));
      };
    `;
    await route.fulfill({ response, body: (await response.text()).replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
  await page.goto("/"); await openConversation(page, "Revision source", options.language === "ko" ? "대화" : "Conversations");
  await expect(cards(page)).toHaveCount(formats.length);
}
const fixture = (page: Page, update: Partial<Fixture>) => page.evaluate(update => Object.assign((window as unknown as { artifactRevisionFixture: Fixture }).artifactRevisionFixture, update), update);
const read = (page: Page) => page.evaluate(() => (window as unknown as { artifactRevisionFixture: Fixture }).artifactRevisionFixture);
const release = (page: Page) => page.evaluate(() => (window as unknown as { artifactRevisionFixture: Fixture }).artifactRevisionFixture.release!());

test("Native Korean workbook preparation keeps the visible localized request and the user's draft", async ({ page }) => {
  await open(page, { formats: ["xlsx"], language: "ko" });
  await input(page).fill("금액을 42로 바꿔 주세요");
  await cards(page).first().getByTestId("native-artifact-revise").click();
  await expect(input(page)).toHaveValue(/첨부한 report.xlsx.*통합 문서 구조.*\n\n금액을 42로 바꿔 주세요/);
  expect((await read(page)).sends).toHaveLength(0);
});

test("Native revision is capability-off by default while Save file remains", async ({ page }) => {
  await open(page, { enabled: false });
  await expect(page.getByTestId("native-artifact-revise")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save file", exact: true })).toHaveCount(2);
});
test("Native selects the older exact same-name artifact and keeps preparation-time typing without Send", async ({ page }) => {
  await open(page); await input(page).fill("Original draft"); await fixture(page, { hold: true });
  await cards(page).first().getByTestId("native-artifact-revise").click();
  await expect.poll(async () => (await read(page)).calls.length).toBe(1);
  await input(page).fill("Original draft plus new typing"); await release(page);
  await expect(page.getByRole("button", { name: "Remove attachment: report.md", exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue("Create a new file from the attached report.md with the changes below. Keep the original file.\n\nOriginal draft plus new typing");
  expect((await read(page)).calls[0].artifactId).toBe("source-old"); expect((await read(page)).sends).toHaveLength(0);
  await cards(page).last().getByTestId("native-artifact-revise").click();
  await expect(page.getByRole("alert")).toContainText("already attached"); expect((await read(page)).calls).toHaveLength(1);
});
test("Native preparation failure preserves the draft and retry reuses its operation", async ({ page }) => {
  await open(page); await input(page).fill("Keep draft"); await fixture(page, { fails: 1 });
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect(page.getByRole("alert")).toBeVisible();
  await expect(input(page)).toHaveValue("Keep draft");
  await cards(page).first().getByTestId("native-artifact-revise").click();
  await expect(page.getByRole("button", { name: "Remove attachment: report.md", exact: true })).toBeVisible();
  const calls = (await read(page)).calls; expect(calls).toHaveLength(2); expect(calls[0].operationId).toBe(calls[1].operationId);
});
test("Native late preparation stays in the original conversation draft", async ({ page }) => {
  await open(page); await fixture(page, { hold: true }); await input(page).fill("Source draft");
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect.poll(async () => (await read(page)).calls.length).toBe(1);
  await openConversation(page, "Other conversation"); await input(page).fill("Other draft"); await release(page);
  await expect(input(page)).toHaveValue("Other draft"); await expect(page.locator(".attachments li")).toHaveCount(0);
  await openConversation(page); await expect(input(page)).toHaveValue(/Create a new file.*\n\nSource draft/);
  await expect(page.locator(".attachments li")).toHaveCount(1);
});
test("Native logout rejects a late preparation and never adds it to another account", async ({ page }) => {
  await open(page); await fixture(page, { hold: true });
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect.poll(async () => (await read(page)).calls.length).toBe(1);
  await page.evaluate(() => (window as unknown as { artifactRevisionFixture: Fixture }).artifactRevisionFixture.lose!());
  await expect(page.getByRole("button", { name: "Continue with Tomverse", exact: true })).toBeVisible();
  await fixture(page, { owner: "another-account" }); await page.getByRole("button", { name: "Continue with Tomverse", exact: true }).click();
  await expect(input(page)).toHaveValue(""); await input(page).fill("Other account draft"); await release(page);
  await expect(input(page)).toHaveValue("Other account draft"); await expect(page.locator(".attachments li")).toHaveCount(0);
});
test("Native files added during preparation preserve ten inputs and clean only the unused copy", async ({ page }) => {
  await open(page); await fixture(page, { hold: true }); await input(page).fill("Keep this draft");
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect.poll(async () => (await read(page)).calls.length).toBe(1);
  await page.getByTestId("file-picker").setInputFiles(Array.from({ length: 10 }, (_, index) => ({ name: `notes-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from("notes") })));
  await expect(page.locator(".attachments li")).toHaveCount(10); await release(page);
  await expect(page.getByRole("alert")).toContainText("up to 10 files"); await expect(input(page)).toHaveValue("Keep this draft");
  await expect(page.locator(".attachments li")).toHaveCount(10); expect((await read(page)).removed).toHaveLength(1);
});
test("Native uploads completing after a prepared revision cannot exceed five or delete the prepared input", async ({ page }) => {
  await open(page); await fixture(page, { hold: true, uploadHold: true }); await input(page).fill("Keep this draft");
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect.poll(async () => (await read(page)).calls.length).toBe(1);
  await page.getByTestId("file-picker").setInputFiles(Array.from({ length: 5 }, (_, index) => ({ name: `notes-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from("notes") })));
  await expect.poll(async () => (await read(page)).uploadStarted).toBe(true);
  await release(page); await expect(page.locator(".attachments li")).toHaveCount(1);
  const preparedId = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-device-draft:synthetic-demo:source-chat:files")!).files[0].uploadId);
  await fixture(page, { uploadHold: false }); await page.evaluate(() => (window as unknown as { artifactRevisionFixture: Fixture }).artifactRevisionFixture.releaseUpload!());
  await expect(page.locator(".attachments li")).toHaveCount(5);
  await expect(page.getByRole("alert")).toContainText(/5/);
  await expect(page.getByRole("button", { name: "Remove attachment: report.md", exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue(/Keep this draft/);
  expect((await read(page)).removed).toHaveLength(1); expect((await read(page)).removed).not.toContain(preparedId);
});
test("Native a prepared result arriving during another Send remains an unsent draft", async ({ page }) => {
  await open(page); await fixture(page, { hold: true, holdSend: true }); await input(page).fill("A separate explicit question");
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect.poll(async () => (await read(page)).calls.length).toBe(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await expect.poll(async () => (await read(page)).sends.length).toBe(1);
  await release(page); await expect(page.locator(".attachments li")).toHaveCount(1); await expect(input(page)).toHaveValue(/Create a new file/);
  await page.evaluate(() => (window as unknown as { artifactRevisionFixture: Fixture }).artifactRevisionFixture.releaseSend!());
  await expect(input(page)).toBeEnabled(); await expect(input(page)).toHaveValue(/Create a new file/); await expect(page.locator(".attachments li")).toHaveCount(1);
  expect((await read(page)).sends).toHaveLength(1);
});
test("Native a same-name upload finishing after preparation preserves the chosen input and draft", async ({ page }) => {
  await open(page); await fixture(page, { hold: true, uploadHold: true }); await input(page).fill("Keep this draft");
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect.poll(async () => (await read(page)).calls.length).toBe(1);
  await page.getByTestId("file-picker").setInputFiles({ name: "report.md", mimeType: "text/markdown", buffer: Buffer.from("Different input") });
  await expect.poll(async () => (await read(page)).uploadStarted).toBe(true);
  await release(page); await expect(page.locator(".attachments li")).toHaveCount(1);
  const preparedId = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-device-draft:synthetic-demo:source-chat:files")!).files[0].uploadId);
  await fixture(page, { uploadHold: false }); await page.evaluate(() => (window as unknown as { artifactRevisionFixture: Fixture }).artifactRevisionFixture.releaseUpload!());
  await expect(page.getByRole("alert")).toContainText("already attached"); await expect(page.locator(".attachments li")).toHaveCount(1);
  await expect(input(page)).toHaveValue(/Keep this draft/);
  expect((await read(page)).removed).toHaveLength(1); expect((await read(page)).removed).not.toContain(preparedId);
  expect((await read(page)).sends).toHaveLength(0);
});
test("Native reload restores the visible request and opaque chip; two explicit sends retain every result", async ({ page }) => {
  await open(page); await input(page).fill("Change the date"); await cards(page).first().getByTestId("native-artifact-revise").click();
  await expect(page.locator(".attachments li")).toHaveCount(1); const visible = await input(page).inputValue();
  await page.reload(); await openConversation(page); await expect(input(page)).toHaveValue(visible); await expect(page.locator(".attachments li")).toHaveCount(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  // The separate fixture ledger stands in for the server's durable upload
  // record. App drafts persist only opaque metadata, never this provenance.
  await expect(cards(page)).toHaveCount(3);
  expect((await read(page)).sends[0].text).toBe(visible);
  await cards(page).last().getByTestId("native-artifact-revise").click();
  await expect(page.locator(".attachments li")).toHaveCount(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await expect(cards(page)).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Save file", exact: true })).toHaveCount(4);
});
test("Native shows truthful Office and legacy-workbook requests and real parent focus", async ({ page }) => {
  await open(page, { formats: ["docx", "xlsx"] });
  await expect(cards(page).first()).toContainText("extracted text");
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect(input(page)).toHaveValue(/extracted text/);
  await page.getByRole("button", { name: "Remove attachment: report.docx", exact: true }).click(); await input(page).fill("");
  await cards(page).last().getByTestId("native-artifact-revise").click();
  await expect(input(page)).toHaveValue(/Preserve its sheets, columns, rows and unchanged cells/);
  await page.getByRole("button", { name: "Remove attachment: report.xlsx", exact: true }).click(); await input(page).fill("");
  await fixture(page, { values: true }); await cards(page).last().getByTestId("native-artifact-revise").click();
  await expect(input(page)).toHaveValue(/Original widths and layout may change/);
  await cards(page).last().getByRole("button", { name: "File versions", exact: true }).click();
  await expect(cards(page).last().locator(".artifact-versions li")).toHaveCount(2);
  await cards(page).last().getByRole("button", { name: /Based on:/ }).click();
  await expect(page.locator("#native-artifact-version-source-new-source-old")).toBeFocused();
});
test("Native a text-only response does not invent a successful or failed file card", async ({ page }) => {
  await open(page); await fixture(page, { textOnly: true }); await input(page).fill("Change the date");
  await cards(page).first().getByTestId("native-artifact-revise").click(); await expect(page.locator(".attachments li")).toHaveCount(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input(page)).toBeEnabled(); await expect(page.locator(".attachments li")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2); await expect(page.getByRole("button", { name: "Save file", exact: true })).toHaveCount(2);
  await expect(page.getByText("This file could not be created.", { exact: true })).toHaveCount(0); expect((await read(page)).sends).toHaveLength(1);
});
test("Native version pagination distinguishes an unloaded source from deletion", async ({ page }) => {
  await open(page); await fixture(page, { paged: true });
  const card = cards(page).last();
  await card.getByRole("button", { name: "File versions", exact: true }).click();
  await expect(card.locator(".artifact-versions li")).toHaveCount(1);
  await expect(card).toContainText("Source not shown on this page");
  await expect(card).not.toContainText("Source no longer available");
  await card.getByRole("button", { name: "Earlier versions", exact: true }).click();
  await expect(card.locator(".artifact-versions li")).toHaveCount(2);
  await card.getByRole("button", { name: /Based on:/ }).click();
  await expect(page.locator("#native-artifact-version-source-new-source-old")).toBeFocused();
});
