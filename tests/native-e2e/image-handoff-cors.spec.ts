import { test, expect } from "@playwright/test";
import { nativeAppCorsHeaders, nativeAppPreflightHeaders } from "../../lib/nativeAppCors";

test("the native WebView can read the image handoff mode through the real CORS policy", async ({ page }) => {
  await page.route("https://localhost/native-image-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Native image protocol fixture</title>" }));
  await page.route("https://api.native-chat.test/api/chat", route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: nativeAppPreflightHeaders("https://localhost")! });
    return route.fulfill({ json: { imageTurn: { modelIds: ["gpt-image-2"], preset: "draft" } }, headers: {
      ...nativeAppCorsHeaders("https://localhost"), "X-Chat-Response-Mode": "image-turn", "X-Synthetic-Private": "not-exposed",
    } });
  });
  await page.goto("https://localhost/native-image-fixture");
  const receipt = await page.evaluate(async () => {
    const response = await fetch("https://api.native-chat.test/api/chat", { method: "POST", headers: { Authorization: "Bearer synthetic-fixture", "Content-Type": "application/json" }, body: "{}" });
    return { mode: response.headers.get("X-Chat-Response-Mode"), privateHeader: response.headers.get("X-Synthetic-Private"), body: await response.json() };
  });
  expect(receipt.mode).toBe("image-turn");
  expect(receipt.privateHeader).toBeNull();
  expect(receipt.body.imageTurn.preset).toBe("draft");
});
