import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const origin = process.env.CAPTURE_ORIGIN || "http://127.0.0.1:3100";
const outputDirectory = "public/marketing-proof";
const outputPath = `${outputDirectory}/three-model-comparison.webm`;

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: {
    dir: outputDirectory,
    size: { width: 1280, height: 720 },
  },
  colorScheme: "dark",
});
const page = await context.newPage();
const capturedModelIds = [];

await page.route("**/api/auth/session**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: null, expires: null }),
  })
);
await page.route("**/api/app-settings", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ guestDefaultModelId: "gpt-5-4-mini" }),
  })
);
await page.route("**/api/models/status", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ models: [] }),
  })
);
await page.route("**/api/chat", async (route) => {
  if (route.request().method() !== "POST") {
    await route.fallback();
    return;
  }
  const body = route.request().postDataJSON();
  capturedModelIds.push(body.modelId || "unknown");
  const responseByModel = {
    "gpt-5-4-mini":
      "**Launch gates**\n\n- Verify payment retries and failed-payment recovery.\n- Set an error-rate threshold before paid traffic.\n- Assign an owner and deadline to every P0 item.",
    "claude-haiku-4-5":
      "**Ownership and communication**\n\n- Define who can pause the launch and how escalation works.\n- Prepare customer messaging for provider incidents.\n- Confirm support coverage during the launch window.",
    "gemini-2-5-flash":
      "**Rollout and rollback**\n\n- Start with a measured traffic cohort.\n- Monitor latency, provider errors, and credit burn.\n- Document automatic and manual rollback triggers.",
  };
  await new Promise((resolve) => setTimeout(resolve, 450));
  await route.fulfill({
    status: 200,
    contentType: "text/plain; charset=utf-8",
    headers: { "X-Request-ID": `demo-${body.modelId || "model"}` },
    body:
      responseByModel[body.modelId] ||
      "Review the launch brief against measurable acceptance criteria.",
  });
});

await page.addInitScript(() => {
  const callbacks = new Map();
  let widgetCounter = 0;
  window.turnstile = {
    render: (_container, options) => {
      widgetCounter += 1;
      const widgetId = `marketing-proof-turnstile-${widgetCounter}`;
      if (typeof options.callback === "function") {
        callbacks.set(widgetId, options.callback);
      }
      return widgetId;
    },
    execute: (widgetId) =>
      queueMicrotask(() => callbacks.get(widgetId)?.("marketing-proof-token")),
    reset: () => {},
    remove: (widgetId) => callbacks.delete(widgetId),
  };
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("tomverse_language", "en");
  localStorage.setItem("tomverse_onboarding_seen_v1", "1");
  localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
  localStorage.setItem("tomverse_analytics_consent_v1", "declined");
  localStorage.setItem("guest_count", "0");
  localStorage.setItem("guest_date", new Date().toDateString());
  document.documentElement.classList.add("dark");
});

const query = new URLSearchParams({
  lang: "en",
  models: "gpt-5-4-mini,claude-haiku-4-5,gemini-2-5-flash",
  prompt: "Compare this launch brief and identify the three highest-priority risks with one next action each.",
  source: "marketing-proof-capture",
});

await page.goto(`${origin}/chat?${query.toString()}`, {
  waitUntil: "networkidle",
});
await page.locator('[data-testid="chat-textarea"]').waitFor({ state: "visible" });
await page.waitForTimeout(1200);
await page.locator('[data-testid="chat-textarea"]').press("Enter");
await page.locator('[data-testid="chat-message"][data-message-role="user"]').first().waitFor({ state: "visible" });
try {
  await page.locator('[data-testid="chat-message"][data-message-role="assistant"]').filter({ hasText: "Launch gates" }).waitFor({ state: "visible", timeout: 15_000 });
} catch (error) {
  const assistantMessages = await page.locator('[data-testid="chat-message"][data-message-role="assistant"]').allTextContents();
  const alerts = await page.locator('[role="alert"]').allTextContents();
  console.error({ capturedModelIds, assistantMessages, alerts });
  throw error;
}
await page.waitForTimeout(3200);

const video = page.video();
await page.close();
if (!video) throw new Error("Playwright did not create a marketing proof video.");
await video.saveAs(outputPath);
await context.close();
await browser.close();

console.log(`Saved ${outputPath}`);
