import { expect, test, type Page, type Request as BrowserRequest } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { readFile } from "node:fs/promises";
import { parseChatE04AutoAction } from "../../lib/chatE04StagingFixture";

const enabled = process.env.E04_QA_BROWSER_SUPPORTED === "1";
const networkObservations = new WeakMap<Page, { requests: string[]; observe: (request: BrowserRequest) => void }>();
async function observeReadyQa(page: Page, baseURL: string) {
  await expect(page.getByTestId("e04-real-chat-ui")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  let observation = networkObservations.get(page);
  if (!observation) {
    const requests: string[] = [];
    const origin = new URL(baseURL).origin;
    observation = { requests, observe: (request) => {
      const url = new URL(request.url());
      const parameters = [...url.searchParams.entries()];
      const query = url.search.slice(1);
      const serverAuto = url.origin === origin && url.pathname === "/api/admin/chat-e2e-fixture" && request.method() === "GET"
        && request.postData() === null && new TextEncoder().encode(query).byteLength <= 512 && query.split("&").length === 1
        && parameters.length === 1 && parameters[0][0] === "action" && parseChatE04AutoAction({ action: parameters[0][1] });
      if (!serverAuto && (url.origin !== origin || url.pathname.startsWith("/api/"))) requests.push(`${request.method()} ${request.url()}`);
    } };
    networkObservations.set(page, observation);
  }
  page.on("request", observation.observe);
}
async function reloadQa(page: Page, baseURL: string) {
  const observation = networkObservations.get(page)!;
  page.off("request", observation.observe);
  await page.reload();
  await observeReadyQa(page, baseURL);
}
async function openQa(page: Page, baseURL: string) {
  const now = Date.now();
  const token = await encode({ secret: process.env.NEXTAUTH_SECRET || "tomverse-e2e-nextauth-secret-only-2026", token: {
    id: "e04-local-admin", sub: "e04-local-admin", name: "E04 Local QA", email: "e04-qa@example.invalid",
    plan: "Free", authenticatedAt: new Date(now).toISOString(), sessionIssuedAt: now,
  } });
  await page.context().addCookies([{ name: process.env.E04_QA_COOKIE_NAME || "next-auth.session-token", value: token,
    url: baseURL, httpOnly: true, sameSite: "Lax", secure: baseURL.startsWith("https:") }]);
  await page.goto("/admin/chat-e2e?lang=en");
  await observeReadyQa(page, baseURL);
}

test("QA action API denies unauthenticated callers", async ({ request, baseURL }) => {
  const response = await request.get("/api/admin/chat-e2e-fixture?action=accepted", { headers: { Origin: baseURL! } });
  expect(response.status()).toBe(404);
  const post = await request.post("/api/admin/chat-e2e-fixture?action=accepted", { headers: { Origin: baseURL! }, data: {} });
  expect(post.status()).toBe(405);
});

test.describe("isolated admin staging fixture harness", () => {
  // This group needs a genuine JWT and admin/staging server env, never a public auth bypass.
  test.skip(!enabled, "Requires an isolated admin/staging QA harness; normal Chat fixture server is not authorized.");
  test.afterEach(async ({ page }) => {
    const observation = networkObservations.get(page);
    if (!observation) return;
    expect(observation.requests).toEqual([]);
    const evidence = JSON.parse((await page.getByTestId("e04-transport-evidence").textContent())!);
    for (const key of ["providerCalls", "costMicroUsd", "productDatabaseWrites", "auditWrites"]) expect(evidence[key]).toBe(0);
  });
  test("default off, actual Chat send, context reuse and synthetic cache reload", async ({ page, baseURL }) => {
    await openQa(page, baseURL!);
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
    await expect(page.getByTestId("e04-real-chat-ui")).toContainText("E04 synthetic retained history answer.");
    await page.getByTestId("chat-textarea").fill("E04 synthetic browser question.");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("e04-real-chat-ui")).toContainText("E04 synthetic answer. No provider was called.");
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"contextBundleReused":true');
    await reloadQa(page, baseURL!);
    await expect(page.getByTestId("e04-real-chat-ui")).toContainText("E04 synthetic browser question.");
    await expect(page.getByTestId("e04-real-chat-ui")).toContainText("E04 synthetic answer. No provider was called.");
  });
  test("actual suggestion preview preserves original and blocks Chat dispatch", async ({ page, baseURL }) => {
    await openQa(page, baseURL!);
    await page.getByTestId("e04-mode-refiner").click();
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("E04 synthetic authored source.");
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toContainText("E04 synthetic preview:");
    await page.getByTestId("prompt-refiner-use").click();
    await expect(textarea).toHaveValue("E04 synthetic authored source.");
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toBeVisible();
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"chatRequests":0');
  });
  test("synthetic failure restores the question for explicit Send without product API traffic", async ({ page, baseURL }) => {
    await openQa(page, baseURL!);
    await page.getByTestId("e04-error-next").click();
    await page.getByTestId("chat-textarea").fill("E04 synthetic retry question.");
    await page.getByTestId("chat-send-button").click();
    await page.getByTestId("restore-chat-question").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("E04 synthetic retry question.");
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"chatRequests":1');
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("e04-real-chat-ui")).toContainText("E04 synthetic answer. No provider was called.");
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"chatRequests":2');
  });
  test("fixed server Auto actions preserve source, fallback and stop unknown outcomes", async ({ page, baseURL }) => {
    await openQa(page, baseURL!);
    await page.getByText("Synthetic Auto facade checks", { exact: true }).click();
    for (const [action, source] of [["default_off", "original"], ["accepted", "accepted_proposal"], ["kept_original", "original"], ["stale", "original"], ["replay", "original"], ["unknown", "none"]]) {
      await page.getByTestId(`e04-auto-${action}`).click();
      await expect(page.getByTestId("e04-auto-evidence")).toContainText(`"action":"${action}"`);
      await expect(page.getByTestId("e04-auto-evidence")).toContainText(`"inputSource":"${source}"`);
      await expect(page.getByTestId("e04-auto-evidence")).toContainText('"dispatchAuthorized":false');
    }
  });
  test("synthetic attachment binds to a Chat card and remains in QA cache after reload", async ({ page, baseURL }) => {
    await openQa(page, baseURL!);
    await page.locator('button[aria-controls="chat-input-popover"]').first().click();
    await page.getByTestId("tools-attach-row").click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("attach-local-file-row").click();
    await (await chooser).setFiles({ name: "e04-synthetic.txt", mimeType: "text/plain", buffer: Buffer.from("E04 synthetic attachment bytes.") });
    await expect(page.getByText("e04-synthetic.txt", { exact: true })).toBeVisible();
    await page.getByTestId("chat-textarea").fill("E04 synthetic attachment question.");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("e04-real-chat-ui")).toContainText("E04 synthetic answer. No provider was called.");
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"attachmentFinalizations":1');
    await reloadQa(page, baseURL!);
    await expect(page.getByTestId("e04-real-chat-ui")).toContainText("e04-synthetic.txt");
  });
  test("fake recorder transcript fills the actual composer before explicit Send", async ({ page, baseURL }) => {
    await openQa(page, baseURL!);
    await page.getByTestId("composer-voice-button").click();
    await expect(page.getByTestId("voice-input-status-row")).toBeVisible();
    await page.getByTestId("composer-voice-button").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("E04 synthetic voice text. Send only when I choose.");
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"chatRequests":0');
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("e04-real-chat-ui")).toContainText("E04 synthetic answer. No provider was called.");
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"voiceRequests":1');
  });
  test("search switch and generated file use synthetic trailers and exact local download bytes", async ({ page, baseURL }) => {
    await openQa(page, baseURL!);
    await page.getByTestId("e04-include-artifact").click();
    await page.locator('button[aria-controls="chat-input-popover"]').first().click();
    await page.getByTestId("tools-web-search-row").click();
    await expect(page.getByTestId("tools-web-search-row")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-textarea").fill("E04 synthetic search and file question.");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("search-status-badge")).toHaveAttribute("data-search-status", "executed");
    await expect(page.getByTestId("search-citation-list")).toContainText("E04 synthetic source");
    const card = page.getByTestId("generated-artifact-card");
    await expect(card.getByTestId("generated-artifact-filename")).toHaveText("e04-synthetic.md");
    const downloadPromise = page.waitForEvent("download");
    await card.getByTestId("generated-artifact-download").click();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    expect(await readFile((await download.path())!, "utf8")).toBe("E04 synthetic generated Markdown.\n");
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"artifactDownloads":1');
    await expect(page.getByTestId("e04-transport-evidence")).toContainText('"searchRequests":1');
  });
});
