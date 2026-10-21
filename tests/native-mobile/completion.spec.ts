import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "en"); });
  await page.route("https://tomverse.app/**", (route) => route.abort());
  await page.route("**/fixture-file", (route) => route.fulfill({ body: "Downloaded content", headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="answer.txt"' } }));
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch(); const source = await response.text();
    const injection = `
      const originalLoad = transport.load;
      transport.load = async (id) => {
        const conversation = await originalLoad(id);
        return { ...conversation, messages: conversation.messages.map((message) => message.role !== "assistant" ? message : ({ ...message,
          content: ${JSON.stringify(["## Answer", "", "**Important**", "", "| A | B |", "| - | - |", "| 1 | 2 |", "", "```js", "const value = 1;", "```"].join("\n"))},
          artifacts: [{ id: "file-a", ordinal: 0, format: "txt", filename: "answer.txt", mediaType: "text/plain", byteSize: 18, status: "ready", modelId: "Demo" }],
          searchMetadata: { citations: [{ title: "Source", url: "https://example.invalid/source" }] }
        })) };
      };
      const { saveMobileResponse } = await import("/src/fileSave.ts");
      transport.downloadArtifact = async () => saveMobileResponse(await fetch("/fixture-file"), "answer.txt");
      transport.account = async () => ({ id: "synthetic-demo", email: "demo@example.invalid", actionsEnabled: true });
      transport.exportAccount = async () => { window.exportCount = (window.exportCount || 0) + 1; if (window.requireReauth) throw { status: 428 }; };
      transport.deleteAccount = async () => { window.deleteCount = (window.deleteCount || 0) + 1; if (window.unknownDelete) throw Error("Unknown result"); };
    `;
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
});
async function signIn(page: import("@playwright/test").Page) { await page.goto("/"); await page.getByRole("button", { name: "Continue with Tomverse" }).click(); await expect(page.getByRole("textbox")).toBeVisible(); }
async function account(page: import("@playwright/test").Page) { await page.getByRole("button", { name: "Language and appearance" }).click(); await page.getByRole("button", { name: "Account, export & deletion" }).click(); }

test("answers render Markdown, citations and generated files with a real browser download", async ({ page }) => {
  await signIn(page); await page.getByRole("textbox").fill("Make a file"); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Answer", exact: true })).toBeVisible(); await expect(page.locator("table")).toBeVisible(); await expect(page.locator("pre code")).toContainText("const value");
  await expect(page.getByRole("link", { name: "Source", exact: true })).toHaveAttribute("rel", "noopener noreferrer");
  const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "Save file", exact: true }).click(); expect((await downloaded).suggestedFilename()).toBe("answer.txt");
  await page.reload(); await expect(page.getByRole("button", { name: "Save file", exact: true })).toBeVisible();
});
test("unsent native drafts survive reload and model selection without a dispatch", async ({ page }) => {
  await signIn(page); await page.getByRole("textbox").fill("Keep this draft"); await page.reload(); await expect(page.getByRole("textbox")).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Choose model", exact: true }).click(); await page.getByRole("radio").check(); await page.getByRole("button", { name: "Apply selection", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Keep this draft"); await expect(page.locator("article.user")).toHaveCount(0);
});
test("account deletion requires typed confirmation and a deliberate click", async ({ page }) => {
  await signIn(page); await account(page); const button = page.getByRole("button", { name: "Delete my account", exact: true }); await expect(button).toBeDisabled();
  await page.getByLabel("Type DELETE MY ACCOUNT to confirm").fill("DELETE MY ACCOUNT"); await expect(button).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { deleteCount?: number }).deleteCount || 0)).toBe(0); await button.click(); await expect(page.getByRole("button", { name: "Continue with Tomverse" })).toBeVisible();
});
test("reauthentication requires an explicit user action", async ({ page }) => {
  await signIn(page); await page.evaluate(() => { (window as unknown as { requireReauth: boolean }).requireReauth = true; }); await account(page);
  await page.getByRole("button", { name: "Export my data", exact: true }).click(); await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { exportCount: number }).exportCount)).toBe(1);
});
test("an uncertain deletion is never automatically retried", async ({ page }) => {
  await signIn(page); await account(page);
  await page.getByLabel("Type DELETE MY ACCOUNT to confirm").fill("DELETE MY ACCOUNT"); await page.evaluate(() => { (window as unknown as { unknownDelete: boolean }).unknownDelete = true; });
  await page.getByRole("button", { name: "Delete my account", exact: true }).click(); await expect(page.getByRole("button", { name: "Delete my account", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { deleteCount: number }).deleteCount)).toBe(1);
  await page.getByRole("button", { name: "Check account status", exact: true }).click();
  await expect(page.getByLabel("Type DELETE MY ACCOUNT to confirm")).toHaveValue("");
  expect(await page.evaluate(() => (window as unknown as { deleteCount: number }).deleteCount)).toBe(1);
});
