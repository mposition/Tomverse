import { test, expect, type Page } from "@playwright/test";
import { buildStreamKeepaliveChunk } from "../../lib/chatStreamKeepalive";

const installDevice = async (page: Page, signedIn = true) => {
  const requests: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = [];
  await page.addInitScript(({ signedIn }) => {
    const state = { signedIn, latitude: -27.4697701, denied: false, reads: 0, browserUrls: [] as string[], proof: false, holdAuth: false, releaseAuth: null as (() => void) | null, hold: false, release: null as (() => void) | null };
    const device = window as unknown as { androidBridge: object; __nativeFixture: typeof state; Capacitor: object };
    device.__nativeFixture = state; device.androidBridge = {};
    const methods = { MobileAuth: ["hasSession", "getAccessToken", "beginSignIn", "completeSignIn", "signOut"],
      Geolocation: ["checkPermissions", "requestPermissions", "getCurrentPosition"], Browser: ["open"] };
    device.Capacitor = {
      PluginHeaders: Object.entries(methods).map(([name, names]) => ({ name, methods: names.map((name) => ({ name, rtype: "promise" })) })),
      nativePromise: async (plugin: string, method: string, options: { url?: string; grant?: string; permissions?: string[] }) => {
        if (plugin === "MobileAuth") {
          if (method === "hasSession") return { signedIn: state.signedIn };
          if (method === "getAccessToken") { if (state.holdAuth) await new Promise<void>((resolve) => { state.releaseAuth = resolve; }); if (!state.signedIn) throw new Error("no session"); return { accessToken: "native-fixture-access", expiresAt: Date.now() + 600_000 }; }
          if (method === "beginSignIn") { state.proof = true; return { url: "https://api.native-chat.test/mobile/connect?codeChallenge=public-fixture-challenge" }; }
          if (method === "completeSignIn") { if (!state.proof || options.grant !== "one-time-fixture") throw new Error("invalid code"); state.proof = false; state.signedIn = true; return; }
          if (method === "signOut") { state.signedIn = false; return; }
        }
        if (plugin === "Browser") { state.browserUrls.push(options.url!); return; }
        if (method === "checkPermissions" || method === "requestPermissions") {
          if (method === "requestPermissions" && JSON.stringify(options.permissions) !== '["coarseLocation"]') throw new Error("unexpected permission");
          return { coarseLocation: state.denied ? "denied" : "granted", location: "denied" };
        }
        if (method === "getCurrentPosition") {
          state.reads++;
          if (state.hold) await new Promise<void>((resolve) => { state.release = resolve; });
          return { coords: { latitude: state.latitude, longitude: 153.0251234, accuracy: 10 }, timestamp: Date.now() };
        }
        throw new Error("unexpected native call");
      },
    };
  }, { signedIn });
  await page.route("https://api.native-chat.test/**", async (route) => {
    const request = route.request();
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (new URL(request.url()).pathname !== "/api/mobile/chat") throw new Error(`Unexpected API call: ${request.url()}`);
    if (request.method() === "GET") return route.fulfill({ json: { userId: "native-user" }, headers });
    requests.push({ body: request.postDataJSON(), authorization: request.headers().authorization });
    await route.fulfill({ body: buildStreamKeepaliveChunk({ state: "awaiting_first_token", elapsedMs: 1 }) + "Nearby places.", headers: { ...headers, "Content-Type": "text/plain" } });
  });
  await page.goto("/");
  return requests;
};

const send = async (page: Page, text: string) => {
  await page.getByTestId("native-chat-input").fill(text);
  await page.getByTestId("native-chat-send").click();
  await expect(page.getByTestId("native-chat-send")).toBeVisible();
};
const device = async (page: Page, patch: Record<string, unknown>) => page.evaluate((patch) => Object.assign((window as unknown as { __nativeFixture: object }).__nativeFixture, patch), patch);

test("native chat defaults off, obtains fresh foreground fixes per message, and clears on sign-out", async ({ page }) => {
  const requests = await installDevice(page);
  await expect(page.getByTestId("native-location-toggle")).not.toBeChecked();
  await send(page, "Hello");
  expect(requests[0].body.currentLocation).toBeUndefined();
  expect(requests[0].authorization).toBe("Bearer native-fixture-access");
  await page.getByTestId("native-location-toggle").check();
  await expect(page.getByTestId("native-location-status")).toContainText("refreshed");
  await send(page, "Nearby?");
  expect(requests[1].body.currentLocation).toMatchObject({ latitude: -27.47, accuracy: 150 });
  await device(page, { latitude: -33.8688 });
  await send(page, "And here?");
  expect(requests[2].body.currentLocation).toMatchObject({ latitude: -33.869 });
  expect(JSON.stringify(requests[2].body.messages)).not.toContain("latitude");
  await page.getByTestId("native-location-toggle").uncheck();
  await send(page, "Continue");
  expect(requests[3].body.currentLocation).toBeUndefined();
  await expect(page.getByTestId("native-messages")).not.toContainText("TOMVERSE_STREAM_KEEPALIVE");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByTestId("native-sign-in")).toBeVisible();
  await expect(page.getByTestId("native-messages")).toHaveCount(0);
});

test("device pairing opens a public challenge and completes with a one-time code", async ({ page }) => {
  await installDevice(page, false);
  await page.getByTestId("native-sign-in").click();
  expect(await page.evaluate(() => (window as unknown as { __nativeFixture: { browserUrls: string[] } }).__nativeFixture.browserUrls)).toEqual(["https://api.native-chat.test/mobile/connect?codeChallenge=public-fixture-challenge"]);
  await page.getByLabel("Connection code", { exact: true }).fill("one-time-fixture");
  await page.getByRole("button", { name: "Connect device", exact: true }).click();
  await expect(page.getByTestId("native-chat-input")).toBeVisible();
  await expect(page.getByTestId("native-location-toggle")).not.toBeChecked();
});

test("denied location still permits chat and stop fences an in-flight location read", async ({ page }) => {
  const requests = await installDevice(page);
  await device(page, { denied: true });
  await page.getByTestId("native-location-toggle").click();
  await expect(page.getByTestId("native-location-status")).toContainText("denied");
  await send(page, "A place by name");
  expect(requests[0].body.currentLocation).toBeUndefined();
  await device(page, { denied: false });
  await page.getByTestId("native-location-toggle").check();
  await expect(page.getByTestId("native-location-status")).toContainText("refreshed");
  await device(page, { hold: true });
  await page.getByTestId("native-chat-input").fill("Cancel this");
  await page.getByTestId("native-chat-send").click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => (window as unknown as { __nativeFixture: { release: () => void } }).__nativeFixture.release());
  await expect(page.getByTestId("native-chat-send")).toBeVisible();
  expect(requests).toHaveLength(1);
});

test("the composer fits a narrow viewport and remains reachable with enlarged text and a keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await installDevice(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.setViewportSize({ width: 320, height: 350 });
  const input = page.getByTestId("native-chat-input");
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeInViewport();
  await input.fill("Weather nearby?");
  await page.getByTestId("native-chat-send").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("native-chat-send")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test("opting out while native authentication is pending removes location before network dispatch", async ({ page }) => {
  const requests = await installDevice(page);
  await page.getByTestId("native-location-toggle").check();
  await expect(page.getByTestId("native-location-status")).toContainText("refreshed");
  await device(page, { holdAuth: true });
  await page.getByTestId("native-chat-input").fill("Nearby?");
  await page.getByTestId("native-chat-send").click();
  await page.waitForFunction(() => typeof (window as unknown as { __nativeFixture: { releaseAuth: unknown } }).__nativeFixture.releaseAuth === "function");
  await page.getByTestId("native-location-toggle").uncheck();
  await page.evaluate(() => (window as unknown as { __nativeFixture: { releaseAuth: () => void } }).__nativeFixture.releaseAuth());
  await expect(page.getByTestId("native-chat-send")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].body.currentLocation).toBeUndefined();
});
