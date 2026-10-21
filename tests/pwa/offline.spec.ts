import { expect, test } from "@playwright/test";

test("offline navigation serves only the public shell and restores a draft only on user action", async ({ page, context }) => {
  await page.goto("/chat");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })); });
  await page.request.get("/api/private-fixture");
  await context.setOffline(true); await page.goto("/chat"); await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
  await page.getByLabel("Draft message").fill("An offline idea"); await page.reload(); await expect(page.getByLabel("Draft message")).toHaveValue("An offline idea");
  await context.setOffline(false); await page.getByRole("link", { name: "Reconnect to Chat" }).click();
  await expect(page.getByLabel("Recovered draft")).toHaveValue("");
  await page.getByRole("button", { name: "Restore offline draft" }).click(); await expect(page.getByLabel("Recovered draft")).toHaveValue("An offline idea");
  const keys = await page.evaluate(async () => { const names = await caches.keys(); return (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)))).flat(); });
  expect(keys.sort()).toEqual(["/chat-offline.html", "/chat-offline.js", "/chat-offline.css", "/pwa/icon-192.png"].sort());
  expect(await page.evaluate(() => sessionStorage.getItem("tomverse-offline-draft"))).toBeNull();
});
test("install prompt requires a user click", async ({ page }) => {
  await page.goto("/chat");
  await page.evaluate(() => { const event = new Event("beforeinstallprompt"); Object.assign(event, { prompt: async () => { document.body.dataset.prompted = "yes"; }, userChoice: Promise.resolve({ outcome: "accepted" }) }); window.dispatchEvent(event); });
  await expect(page.getByRole("button", { name: "Install Tomverse" })).toBeVisible(); expect(await page.locator("body").getAttribute("data-prompted")).toBeNull();
  await page.getByRole("button", { name: "Install Tomverse" }).click(); await expect(page.locator("body")).toHaveAttribute("data-prompted", "yes");
});
