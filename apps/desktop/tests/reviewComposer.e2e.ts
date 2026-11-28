import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { expect, type Page } from "@playwright/test";
import { closeReviewColumns, columnsOrigin, launchReviewColumns } from "./review-columns-fixture";

// Set to a folder to keep light and dark pictures of the composers this test opens.
const shots = process.env.DESKTOP_E2E_SCREENSHOTS;
const pixel = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWNQj9tFEmIY1RA3GkrqwzVpAAAEqD8QpAelQwAAAABJRU5ErkJggg==";

async function picture(page: Page, form: string, name: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.locator(form).screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

/** The classes of the composer row's controls, in the order they stand. */
const rowOrder = (page: Page, form: string) => page.locator(`${form} .composer-actions > *`).evaluateAll((nodes) =>
  nodes.filter((node) => (node as HTMLElement).offsetParent !== null || node.classList.contains("spacer"))
    .map((node) => node.classList.contains("composer-tools") ? "tools" : node.classList.contains("desktop-chat-connector") ? "plugin"
      : node.classList.contains("spacer") ? "spacer" : node.classList.contains("review-participants") || node.querySelector(".desktop-model-trigger") || node.classList.contains("desktop-model-trigger") ? "models"
      : node.classList.contains("desktop-dictation") && !node.classList.contains("desktop-dictation--command") ? "microphone"
      : node.classList.contains("send") || node.classList.contains("desktop-dictation--command") ? "send" : "other:" + node.className));

test("Desktop Review's composer row is Chat's: +, plugin, then the providers or models, the microphone and Send", { timeout: 150_000, skip: !columnsOrigin }, async () => {
  const session = await launchReviewColumns({ width: 1400, height: 950,
    capabilities: { desktopAttachments: true, desktopPlugins: true, desktopReviewPlugin: true } });
  const { app, desktop } = session;
  try {
    // The connection list comes from the account's plugins; the fixture answers it with the feature on and nothing connected.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("desktop:connector-inventory");
      ipcMain.handle("desktop:connector-inventory", () => ({ enabled: true, servers: [], connections: [], invocations: [] }));
    });
    assert.equal((await desktop.evaluate(() => window.desktop.state())).capabilities?.reviewPlugin, true);
    // The composer reads the list when it opens: open the Review again.
    const rail = desktop.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: "Chat", exact: true }).click();
    await rail.getByRole("button", { name: "Review", exact: true }).click();
    const form = 'form[aria-label="Review composer"]';
    const composer = desktop.locator(form);
    await expect(composer.getByTestId("desktop-chat-connector")).toBeVisible();

    // Easy: the providers stand where Chat keeps its model picker, left of the microphone and Send.
    await composer.getByRole("button", { name: "Easy", exact: true }).click();
    await expect(composer.locator(".composer-actions .review-participants")).toBeVisible();
    assert.deepEqual(await rowOrder(desktop, form), ["tools", "plugin", "spacer", "models", "microphone", "send"]);
    // The mode switch stays above the text box.
    assert.equal(await composer.locator(".review-setup .review-mode-toggle").count(), 1);

    // An image waiting to be sent shows as a thumbnail.
    await composer.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
    const thumbnail = composer.getByTestId("attachment-draft-thumb");
    await expect(thumbnail).toHaveCount(1);
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(16);
    await picture(desktop, form, "review-easy");

    // Professional: the model picker takes the same place.
    await composer.getByRole("button", { name: "Professional", exact: true }).click();
    await expect(composer.locator(".composer-actions .desktop-model-trigger")).toBeVisible();
    assert.deepEqual(await rowOrder(desktop, form), ["tools", "plugin", "spacer", "models", "microphone", "send"]);
    await picture(desktop, form, "review-professional");

    // Chat, for comparison: the same order.
    await desktop.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: "Chat", exact: true }).click();
    const chat = "form.chat-composer";
    await expect(desktop.locator("#chat-draft-input")).toBeVisible();
    await picture(desktop, chat, "chat");
  } finally {
    await closeReviewColumns(session);
  }
});
