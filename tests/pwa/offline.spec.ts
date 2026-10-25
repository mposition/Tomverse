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
test("install prompt lives in the account menu and survives a sidebar switch without moving chat", async ({ page }) => {
  await page.goto("/chat");
  const before = await page.getByLabel("Recovered draft").boundingBox();
  await page.evaluate(() => { const event = new Event("beforeinstallprompt"); Object.assign(event, { prompt: async () => { document.body.dataset.prompted = "yes"; }, userChoice: Promise.resolve({ outcome: "accepted" }) }); window.dispatchEvent(event); });
  await expect(page.getByRole("button", { name: "Install Tomverse" })).toHaveCount(0);
  await expect(page.locator('aside[aria-label="Tomverse app"]')).toHaveCount(0);
  expect(await page.getByLabel("Recovered draft").boundingBox()).toEqual(before);
  expect(await page.locator("body").getAttribute("data-prompted")).toBeNull();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("group", { name: "Account menu" }).getByRole("button", { name: "Install Tomverse" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-prompted", "yes");
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await expect(page.getByTestId("account-install-app")).toHaveCount(0);
});

const installLabels = { en: "Install Tomverse", ko: "Tomverse 앱 설치", zh: "安装 Tomverse", de: "Tomverse installieren", fr: "Installer Tomverse", es: "Instalar Tomverse", pt: "Instalar Tomverse" };
test("install remains available when the mobile account host mounts after the browser event", async ({ page }) => {
  await page.goto("/chat?drawer=closed&lang=ko");
  await expect(page.getByRole("button", { name: "Account menu", exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "dismissed" }) });
    window.dispatchEvent(event);
  });
  await page.getByRole("button", { name: "Open mobile drawer" }).click();
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await expect(page.getByTestId("account-install-app")).toHaveText(installLabels.ko);
});

for (const [language, label] of Object.entries(installLabels)) {
  test(`account install follows the preferred ${language} language`, async ({ page }) => {
    await page.goto(`/chat?lang=${language}`);
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt");
      Object.assign(event, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "dismissed" }) });
      window.dispatchEvent(event);
    });
    await page.getByRole("button", { name: "Account menu", exact: true }).click();
    await expect(page.getByTestId("account-install-app")).toHaveText(label);
    await page.getByLabel("Language").selectOption(language === "ko" ? "en" : "ko");
    await expect(page.getByTestId("account-install-app")).toHaveText(language === "ko" ? installLabels.en : installLabels.ko);
  });
}

test("iPad desktop mode shows localized install instructions only inside the menu", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
  });
  await page.goto("/chat?lang=ko");
  await expect(page.locator('aside[aria-label="Tomverse app"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByTestId("account-install-app").click();
  await expect(page.getByRole("group", { name: "Account menu" }).getByRole("status")).toHaveText("Safari에서 공유 버튼을 누른 뒤 ‘홈 화면에 추가’를 선택하세요.");
  await page.getByLabel("Language").selectOption("fr");
  await expect(page.getByRole("status")).toContainText("Dans Safari");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.getByTestId("account-install-app")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("standalone and unsupported browsers do not show an install action or blank banner", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await expect(page.getByTestId("account-install-app")).toHaveCount(0);
  await expect(page.locator('aside[aria-label="Tomverse app"]')).toHaveCount(0);
  await page.addInitScript(() => { Object.defineProperty(navigator, "standalone", { value: true }); Object.defineProperty(navigator, "userAgent", { value: "iPhone" }); });
  await page.reload();
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await expect(page.getByTestId("account-install-app")).toHaveCount(0);
});

test("a rejected browser prompt is consumed once and a fresh event can offer install again", async ({ page }) => {
  await page.goto("/chat");
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, { prompt: async () => { throw new Error("unavailable"); }, userChoice: Promise.resolve({ outcome: "dismissed" }) });
    window.dispatchEvent(event);
  });
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByTestId("account-install-app").click();
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await expect(page.getByTestId("account-install-app")).toHaveCount(0);
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "dismissed" }) });
    window.dispatchEvent(event);
  });
  await expect(page.getByTestId("account-install-app")).toBeVisible();
});
test("another account never receives the previous account's offline draft", async ({ page }) => {
  await page.addInitScript(() => { sessionStorage.setItem("tomverse-offline-owner", "account:a"); sessionStorage.setItem("tomverse-offline-draft", JSON.stringify({ owner: "account:a", text: "Account A only" })); });
  await page.goto("/?owner=account%3Aa"); await expect(page.getByRole("button", { name: "Restore offline draft" })).toBeVisible();
  await page.getByRole("button", { name: "Switch account" }).click(); await expect(page.getByRole("button", { name: "Restore offline draft" })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("tomverse-offline-draft"))).toBeNull(); await expect(page.getByLabel("Recovered draft")).toHaveValue("");
});
