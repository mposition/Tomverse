import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __memorySettingsRequests: Array<{
      aborted: boolean;
      resolve: (value: unknown, status?: number) => void;
      reject: () => void;
    }>;
  }
}

/** Deferred transport deliberately completes after abort to exercise the hook's stale guard. */
const mountSettingsHook = async (page: Page) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.__memorySettingsRequests = [];
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      if (!url.includes("/api/memories/settings")) return originalFetch(input, init);
      return new Promise<Response>((resolve, reject) => {
        const request = {
          aborted: init?.signal?.aborted ?? false,
          resolve: (value: unknown, status = 200) => resolve(new Response(JSON.stringify(value), {
            status, headers: { "content-type": "application/json" },
          })),
          reject: () => reject(new TypeError("synthetic_settings_failure")),
        };
        init?.signal?.addEventListener("abort", () => { request.aborted = true; });
        window.__memorySettingsRequests.push(request);
      });
    };
  });
  await page.goto("/e2e/memory-settings-fixture");
  await expect(page.getByTestId("settings-owner")).toHaveText("account-a");
};
const requestCount = (page: Page) => page.evaluate(() => window.__memorySettingsRequests.length);
const nextRequest = async (page: Page, previousCount: number) => {
  await expect.poll(() => requestCount(page)).toBeGreaterThan(previousCount);
  return (await requestCount(page)) - 1;
};
const reply = (page: Page, index: number, masterEnabled: boolean, defaultConversationMode: "on" | "off") =>
  page.evaluate(({ index, masterEnabled, defaultConversationMode }) => {
    window.__memorySettingsRequests[index].resolve({ masterEnabled, defaultConversationMode });
  }, { index, masterEnabled, defaultConversationMode });

test("account A to B to A discards old permissions and ignores a late aborted response", async ({ page }) => {
  await mountSettingsHook(page);
  const first = await nextRequest(page, 0);
  await page.getByRole("button", { name: "Account B", exact: true }).click();
  await expect(page.getByTestId("settings-snapshot")).toHaveText("unknown");
  const second = await nextRequest(page, first + 1);
  await reply(page, second, false, "on");
  await expect(page.getByTestId("settings-snapshot")).toHaveText("off:on");
  expect(await page.evaluate((index) => window.__memorySettingsRequests[index].aborted, first)).toBe(true);
  await reply(page, first, true, "on");
  await expect(page.getByTestId("settings-owner")).toHaveText("account-b");
  await expect(page.getByTestId("settings-snapshot")).toHaveText("off:on");
  await page.getByRole("button", { name: "Account A", exact: true }).click();
  await expect(page.getByTestId("settings-snapshot")).toHaveText("unknown");
  const third = await nextRequest(page, second + 1);
  await reply(page, third, true, "off");
  await expect(page.getByTestId("settings-snapshot")).toHaveText("allowed:off");
});

test("HTTP, malformed and network failures keep settings unknown after a refresh", async ({ page }) => {
  await mountSettingsHook(page);
  let latest = await nextRequest(page, 0);
  await reply(page, latest, true, "on");
  await expect(page.getByTestId("settings-snapshot")).toHaveText("allowed:on");
  for (const failure of ["http", "malformed", "network"] as const) {
    const before = await requestCount(page);
    await page.getByRole("button", { name: "Refresh settings", exact: true }).click();
    await expect(page.getByTestId("settings-snapshot")).toHaveText("unknown");
    latest = await nextRequest(page, before);
    await page.evaluate(({ index, failure }) => {
      const request = window.__memorySettingsRequests[index];
      if (failure === "network") request.reject();
      else if (failure === "http") request.resolve({ masterEnabled: true, defaultConversationMode: "on" }, 503);
      else request.resolve({ masterEnabled: "true", defaultConversationMode: "invalid" });
    }, { index: latest, failure });
    await expect(page.getByTestId("settings-snapshot")).toHaveText("unknown");
  }
});

test("returning from settings refreshes on focus, pageshow and visible state", async ({ page }) => {
  await mountSettingsHook(page);
  let latest = await nextRequest(page, 0);
  await reply(page, latest, true, "on");
  await expect(page.getByTestId("settings-snapshot")).toHaveText("allowed:on");
  for (const event of ["focus", "pageshow", "visibilitychange"] as const) {
    const before = await requestCount(page);
    await page.evaluate((event) => {
      if (event === "visibilitychange") {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event(event));
      } else window.dispatchEvent(new Event(event));
    }, event);
    await expect(page.getByTestId("settings-snapshot")).toHaveText("unknown");
    latest = await nextRequest(page, before);
    await reply(page, latest, false, "off");
    await expect(page.getByTestId("settings-snapshot")).toHaveText("off:off");
  }
  const beforeHidden = await requestCount(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await requestCount(page)).toBe(beforeHidden);
});

test("signing out clears the snapshot and ignores the pending account response", async ({ page }) => {
  await mountSettingsHook(page);
  const pending = await nextRequest(page, 0);
  await page.getByRole("button", { name: "Guest", exact: true }).click();
  await expect(page.getByTestId("settings-owner")).toHaveText("guest");
  await expect(page.getByTestId("settings-snapshot")).toHaveText("unknown");
  await reply(page, pending, true, "on");
  await expect(page.getByTestId("settings-snapshot")).toHaveText("unknown");
  expect(await requestCount(page)).toBe(pending + 1);
});
