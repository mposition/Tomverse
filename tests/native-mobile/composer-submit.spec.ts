import { expect, test, type Page } from "@playwright/test";
import { selectProduct } from "./workspaceNavigation";

type SubmissionFixture = { releaseCreate: () => void; releaseResponse: () => void; responseStarted: boolean; sends: number };

async function open(page: Page, product: "chat" | "review", fixture: string) {
  await page.addInitScript(() => localStorage.setItem("tomverse-language", "en"));
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Tomverse" }).click();
  if (product === "review") await selectProduct(page, product);
  await expect(page.getByRole("textbox")).toBeEnabled();
}

for (const product of ["chat", "review"] as const) {
  const create = product === "chat" ? "create" : "createReview";
  const send = product === "chat" ? "send" : "sendReview";

  test(`${product} clears the composer and shows the question before creation or the response finishes`, async ({ page }) => {
    await open(page, product, `
      const originalCreate=transport.${create}, originalSend=transport.${send};
      window.submissionFixture={sends:0,responseStarted:false};
      transport.${create}=async(...args)=>{await new Promise(resolve=>window.submissionFixture.releaseCreate=resolve);return originalCreate(...args);};
      transport.${send}=async(...args)=>{window.submissionFixture.sends++;window.submissionFixture.responseStarted=true;await new Promise(resolve=>window.submissionFixture.releaseResponse=resolve);return originalSend(...args);};
    `);
    const input = page.getByRole("textbox");
    const question = "A question submitted once";
    await input.fill(question);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(page.locator("article.user")).toHaveText(question);
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
    await page.evaluate(() => (window as unknown as { submissionFixture: SubmissionFixture }).submissionFixture.releaseCreate());
    await expect.poll(() => page.evaluate(() => (window as unknown as { submissionFixture: SubmissionFixture }).submissionFixture.responseStarted)).toBe(true);
    await expect(input).toHaveValue("");
    await expect(page.locator("article.user")).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { submissionFixture: SubmissionFixture }).submissionFixture.releaseResponse());
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
    expect(await page.evaluate(() => (window as unknown as { submissionFixture: SubmissionFixture }).submissionFixture.sends)).toBe(1);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(input).toHaveValue("");
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await page.locator(".conversation-row").first().click();
    await expect(input).toHaveValue("");
  });

  test(`${product} restores the draft and attachment when creation fails before dispatch`, async ({ page }) => {
    await open(page, product, `
      window.submissionFixture={sends:0};
      transport.${create}=async()=>{await new Promise(resolve=>window.submissionFixture.releaseCreate=resolve);throw Error('Creation unavailable');};
      transport.${send}=async()=>{window.submissionFixture.sends++;throw Error('Must not send');};
    `);
    const input = page.getByRole("textbox");
    await page.getByTestId("file-picker").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic draft") });
    await expect(page.getByRole("button", { name: "Remove attachment: draft.txt" })).toBeVisible();
    await input.fill("Keep this unsent question");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(input).toHaveValue("");
    await page.evaluate(() => (window as unknown as { submissionFixture: SubmissionFixture }).submissionFixture.releaseCreate());
    await expect(input).toHaveValue("Keep this unsent question");
    await expect(input).toBeEnabled();
    await expect(page.getByRole("button", { name: "Remove attachment: draft.txt" })).toBeVisible();
    await expect(page.locator("article.user")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { submissionFixture: SubmissionFixture }).submissionFixture.sends)).toBe(0);
  });

  test(`${product} keeps a dispatched question out of the composer after an unknown failure`, async ({ page }) => {
    await open(page, product, `transport.${send}=async()=>{throw Error('Connection lost after dispatch');};`);
    await page.getByRole("textbox").fill("Do not automatically send this twice");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("button", { name: /Check saved response/ })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("");
    await expect(page.getByRole("textbox")).toBeDisabled();
    await expect(page.locator("article.user")).toHaveText("Do not automatically send this twice");
  });

  test(`${product} restores a cancelled draft without dispatching after a delayed creation`, async ({ page }) => {
    await open(page, product, `
      const create=transport.${create};window.submissionFixture={sends:0};
      transport.${create}=async(...args)=>{await new Promise(resolve=>window.submissionFixture.releaseCreate=resolve);return create(...args);};
      transport.${send}=async()=>{window.submissionFixture.sends++;throw Error('Must not send');};
    `);
    await page.getByRole("textbox").fill("Cancel before submitting to a model");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("textbox")).toHaveValue("");
    await page.getByRole("button", { name: "Stop response" }).click();
    await page.evaluate(() => (window as unknown as { submissionFixture: SubmissionFixture }).submissionFixture.releaseCreate());
    await expect(page.getByRole("textbox")).toHaveValue("Cancel before submitting to a model");
    await expect(page.getByRole("textbox")).toBeEnabled();
    await expect(page.locator("article.user")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { submissionFixture: SubmissionFixture }).submissionFixture.sends)).toBe(0);
  });
}

test("Review does not restore a saved question when one model fails", async ({ page }) => {
  await open(page, "review", `const sendReview=transport.sendReview;transport.sendReview=async(...args)=>{await sendReview(...args);return {failedModelIds:['demo']};};`);
  await page.getByRole("textbox").fill("One saved comparison question");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("textbox")).toBeEnabled();
  await expect(page.getByRole("textbox")).toHaveValue("");
  await expect(page.locator("article.user")).toHaveText("One saved comparison question");
});
