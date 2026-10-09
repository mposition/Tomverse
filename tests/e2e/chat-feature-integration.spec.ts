import { readFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { buildArtifactProgressChunk } from "@/lib/generatedArtifactProgressSignal";
import { AVAILABLE_MODELS } from "@/lib/models";
import { toPublicCatalogModel } from "@/lib/publicModelCatalog";
import { buildChatStreamTrailerChunk } from "@/lib/webSearchStreamTrailer";
import {
  createQaPdfBuffer,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";

// CHAT-01 E03: product /chat plumbing with synthetic public API/provider
// responses. This covers browser integration, not account DB persistence,
// provider execution, transcription quality, or real microphone codecs.
type ChatRequest = {
  modelId: string;
  webSearchMode?: string;
  messages: Array<{
    role: string;
    content: string;
    attachments?: Array<{ attachmentId?: string; uploadId?: string; name?: string }>;
  }>;
};
type SavedMessage = {
  clientRequestId?: string;
  role: string;
  content: string;
  attachmentUploadIds?: string[];
};
type NetworkBoundary = { external: string[]; unmockedApi: string[] };

const MODEL_ID = "gpt-5-6-luna";
const toolsTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').first();
const visibleTurn = (page: Page, role: string) =>
  page.locator(`[data-message-role="${role}"]`).filter({ visible: true });
const newestUser = (request: ChatRequest) =>
  [...request.messages].reverse().find((message) => message.role === "user")!;

async function installNetworkBoundary(page: Page): Promise<NetworkBoundary> {
  const boundary: NetworkBoundary = { external: [], unmockedApi: [] };
  // Registered first at context level so specific page and context mocks may
  // answer. Any API not explicitly mocked is blocked before it reaches the app.
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.protocol.startsWith("http")) {
      await route.fallback();
      return;
    }
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      boundary.external.push(url.hostname);
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      boundary.unmockedApi.push(`${route.request().method()} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
  return boundary;
}

async function prepareAccount(page: Page) {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, {
    selectedModels: [MODEL_ID],
    assistantProfiles: [],
    webSearchMode: "off",
  });
  // These normally run against the loopback server in existing suites. Keep
  // this integration suite provider/DB-free even for background preparation.
  await page.route("**/api/models/catalog", (route) => route.fulfill({
    json: { models: AVAILABLE_MODELS.map(toPublicCatalogModel) },
  }));
  await page.route("**/api/build-info", (route) => route.fulfill({
    json: {
      environment: "development",
      commitSha: null,
      shortCommitSha: null,
      builtAt: null,
      deploymentId: null,
      deploymentStartedAt: null,
      deployedAt: null,
      deploymentStatus: "unknown",
    },
  }));
  await page.route("**/api/chat/context", (route) => route.fulfill({
    json: { ok: true, contextBundle: null, memoryUsedCount: 0 },
  }));
  await page.route("**/api/chat/availability", (route) => {
    const { modelIds = [], webSearchMode = "off" } = route.request().postDataJSON() as {
      modelIds?: string[];
      webSearchMode?: string;
    };
    return route.fulfill({ json: {
      traceId: "synthetic-e03-availability",
      plan: "Free",
      runnable: true,
      blockCode: null,
      blockLayer: null,
      webSearchMode,
      estimate: {
        requiredCredits: modelIds.length,
        planCreditsUsedByRequest: modelIds.length,
        purchasedCreditsUsedByRequest: 0,
        models: modelIds.map((modelId) => ({ modelId, credits: 1, estimatedInputTokens: 1, estimatedOutputTokens: 1 })),
      },
      entitlement: {
        dailyCreditLimit: 100,
        dailyCreditsUsed: 0,
        dailyCreditsRemaining: 100,
        hasDailyCreditLimit: true,
        planCreditsRemaining: 100,
        purchasedCreditsRemaining: 0,
        creditsAvailableNow: 100,
        creditShortfall: 0,
        timeZone: "UTC",
        dailyResetsAt: "2099-01-02T00:00:00.000Z",
        planResetsAt: "2099-02-01T00:00:00.000Z",
      },
    } });
  });
  await page.route("**/api/conversations/qa-conversation/generate-title", (route) =>
    route.fulfill({ json: { updated: false } })
  );
}

async function mockAnswer(page: Page, answer: string) {
  const requests: ChatRequest[] = [];
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    requests.push(route.request().postDataJSON() as ChatRequest);
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": "synthetic-e03-chat" },
      body: answer,
    });
  });
  return requests;
}

async function sendDraft(page: Page) {
  await page.getByTestId("chat-send-button").click();
}

async function finishEvidence(
  testInfo: TestInfo,
  feature: string,
  boundary: NetworkBoundary,
  evidence: Record<string, unknown>
) {
  expect(boundary.external).toEqual([]);
  expect(boundary.unmockedApi).toEqual([]);
  await testInfo.attach(`synthetic-e03-${feature}`, {
    body: JSON.stringify({ feature, ...evidence, boundary }, null, 2),
    contentType: "application/json",
  });
}

// The recorder and device are intentionally synthetic on every project. A
// real Blob still goes through the product capture/transcription/draft path;
// this does not claim MP4 bytes or real Safari microphone compatibility.
async function installSyntheticRecorder(page: Page) {
  await page.addInitScript(() => {
    const state = { grants: 0, liveTracks: 0, recorderStarts: 0, uploads: [] as number[] };
    (window as unknown as { __e03Voice: typeof state }).__e03Voice = state;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          state.grants += 1;
          state.liveTracks += 1;
          let stopped = false;
          return {
            getTracks: () => [{
              stop: () => {
                if (stopped) return;
                stopped = true;
                state.liveTracks -= 1;
              },
            }],
          };
        },
      },
    });
    class SyntheticRecorder {
      static isTypeSupported(type: string) {
        return type.split(";", 1)[0] === "audio/mp4";
      }
      state = "inactive";
      readonly mimeType: string;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((event?: unknown) => void) | null = null;
      constructor(_stream: unknown, options?: { mimeType?: string }) {
        this.mimeType = options?.mimeType || "audio/mp4";
      }
      start() {
        this.state = "recording";
        state.recorderStarts += 1;
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        setTimeout(() => {
          this.ondataavailable?.({
            data: new Blob([new Uint8Array(4096)], { type: this.mimeType }),
          });
          this.onstop?.();
        }, 0);
      }
    }
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: SyntheticRecorder,
    });
    // WebKit's intercepted request can omit Blob postDataBuffer; observe the
    // actual Blob the product hands to fetch instead of assuming no upload.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/chat/voice-transcription") && init?.body instanceof Blob) {
        state.uploads.push(init.body.size);
      }
      return nativeFetch(input, init);
    };
  });
}

test("attachment input reaches Chat and its durable card survives reload", async ({ page }, testInfo) => {
  const boundary = await installNetworkBoundary(page);
  await prepareAccount(page);
  const uploads = await mockAttachmentUpload(page);
  const requests = await mockAnswer(page, "Synthetic attachment received.");
  const saved: SavedMessage[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/conversations\/[^/]+\/messages/.test(request.url())) {
      saved.push(...((request.postDataJSON() as { messages?: SavedMessage[] }).messages || []));
    }
  });
  await page.goto("/chat");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();

  await toolsTrigger(page).click();
  await page.getByTestId("tools-attach-row").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("attach-local-file-row").click();
  await (await chooserPromise).setFiles({
    name: "synthetic-e03.pdf",
    mimeType: "application/pdf",
    buffer: createQaPdfBuffer(),
  });
  await expect(page.getByText("synthetic-e03.pdf", { exact: true })).toBeVisible();
  await page.getByTestId("chat-textarea").fill("Read this synthetic attachment.");
  const userSaveResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/api\/conversations\/qa-conversation\/messages/.test(response.url())
  );
  await sendDraft(page);
  await expect(visibleTurn(page, "assistant")).toContainText("Synthetic attachment received.");
  await expect(visibleTurn(page, "user")).toContainText("synthetic-e03.pdf");
  await expect.poll(() => requests.length).toBe(1);
  const boundSave = await (await userSaveResponse).json() as {
    messageMappings: Array<{ requestId: string; messageId: string }>;
    attachments: Array<NonNullable<QaConversationMessage["attachments"]>[number] & { messageId: string }>;
  };
  const savedUser = saved.find((message) => message.role === "user")!;
  expect(savedUser.attachmentUploadIds).toEqual(uploads.uploadIds);
  const userMapping = boundSave.messageMappings.find((mapping) => mapping.requestId === savedUser.clientRequestId)!;
  expect(userMapping).toBeTruthy();
  const durableAttachments = boundSave.attachments.filter((attachment) => attachment.messageId === userMapping.messageId);
  expect(durableAttachments).toHaveLength(1);
  expect(durableAttachments[0].attachmentId).toEqual(expect.any(String));
  expect(newestUser(requests[0]).attachments).toHaveLength(1);
  const initialReference = newestUser(requests[0]).attachments?.[0];
  expect(initialReference?.attachmentId).toBe(durableAttachments[0].attachmentId);
  expect(initialReference).not.toHaveProperty("uploadId");
  expect(JSON.stringify(requests)).not.toContain("objectKey");
  expect(JSON.stringify(saved)).not.toContain("attachments/");
  expect(uploads.finalizeCount).toBe(1);

  // In account Chat, /api/chat owns the assistant write; the browser only
  // posts the user message. Its mocked stream cannot perform that DB write.
  // Supply the server-owned assistant result at the authenticated API
  // boundary, retaining the *observed* user-save mapping and attachment rows.
  // Reload below still runs the real product's read/restore path.
  await mockAuthenticatedApi(page, {
    selectedModels: [MODEL_ID],
    assistantProfiles: [],
    webSearchMode: "off",
    messages: [
      { id: userMapping.messageId, role: "user", content: savedUser.content, attachments: durableAttachments },
      { id: "synthetic-e03-server-assistant", role: "assistant", content: "Synthetic attachment received.", modelId: MODEL_ID },
    ],
  });
  await page.reload();
  await expect(visibleTurn(page, "user")).toContainText("synthetic-e03.pdf");
  await expect(visibleTurn(page, "assistant")).toContainText("Synthetic attachment received.");
  expect(requests).toHaveLength(1);
  await page.getByTestId("chat-textarea").fill("Use the same synthetic attachment again.");
  await sendDraft(page);
  await expect.poll(() => requests.length).toBe(2);
  const restoredUser = requests[1].messages.find((message) => message.role === "user" && message.content === "Read this synthetic attachment.");
  expect(restoredUser?.attachments?.[0].attachmentId).toBe(durableAttachments[0].attachmentId);
  expect(JSON.stringify(requests[1])).not.toContain("objectKey");
  await finishEvidence(testInfo, "attachment", boundary, { requests, saved, boundSave, uploads, assistantPersistence: "synthetic-server-owned-result" });
});

test("voice transcription fills the draft and explicit Send reaches Chat once", async ({ page }, testInfo) => {
  const boundary = await installNetworkBoundary(page);
  await prepareAccount(page);
  await installSyntheticRecorder(page);
  await page.context().addCookies([{
    name: "__tomverse_e2e_voice_input",
    value: "1",
    url: testInfo.project.use.baseURL!,
  }]);
  const transcript = "Synthetic voice text 42: send only when I choose.";
  const voiceRequests: Array<{ method: string; contentType: string }> = [];
  await page.route("**/api/chat/voice-transcription", async (route) => {
    voiceRequests.push({
      method: route.request().method(),
      contentType: route.request().headers()["content-type"] || "",
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ transcript }) });
  });
  const requests = await mockAnswer(page, "Synthetic voice Chat answer.");
  await page.goto("/chat");
  await expect(page.getByTestId("composer-voice-button")).toBeEnabled();
  await page.getByTestId("composer-voice-button").click();
  await expect(page.getByTestId("voice-input-status-row")).toBeVisible();
  // The client has a byte floor, not a minimum recording duration. Wait for
  // actual recorder.start(), then stop; the synthetic clip supplies 4096 bytes.
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __e03Voice: { recorderStarts: number } }).__e03Voice.recorderStarts
  )).toBe(1);
  await page.getByTestId("composer-voice-button").click();
  await expect(page.getByTestId("chat-textarea")).toHaveValue(transcript);
  await expect(page.getByTestId("voice-input-status-row")).toHaveCount(0);
  expect(requests).toHaveLength(0);
  expect(voiceRequests).toEqual([{ method: "POST", contentType: "audio/mp4" }]);
  const capture = await page.evaluate(() =>
    (window as unknown as { __e03Voice: { grants: number; liveTracks: number; recorderStarts: number; uploads: number[] } }).__e03Voice
  );
  expect(capture).toEqual({ grants: 1, liveTracks: 0, recorderStarts: 1, uploads: [4096] });
  await sendDraft(page);
  await expect(visibleTurn(page, "assistant")).toContainText("Synthetic voice Chat answer.");
  expect(requests).toHaveLength(1);
  expect(newestUser(requests[0]).content).toBe(transcript);
  await expect(visibleTurn(page, "user")).toContainText(transcript);
  testInfo.annotations.push({ type: "voice-recorder", description: "synthetic-device-and-recorder" });
  await finishEvidence(testInfo, "voice", boundary, { requests, voiceRequests, capture });
});

test("web search switch reaches Chat and renders the returned source", async ({ page }, testInfo) => {
  const boundary = await installNetworkBoundary(page);
  await prepareAccount(page);
  const source = { url: "https://example.com/synthetic-e03-source", title: "Synthetic E03 source" };
  const requests = await mockAnswer(page, "Synthetic sourced answer." + buildChatStreamTrailerChunk({
    completion: { status: "normal" },
    searchMetadata: {
      requested: true,
      supported: true,
      executed: true,
      provider: "openai",
      tool: "web_search",
      citations: [source],
    },
  }));
  await page.goto("/chat");
  await openRecentConversation(page);
  await toolsTrigger(page).click();
  const toggle = page.getByTestId("tools-web-search-row");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByTestId("chat-textarea").fill("Find the synthetic source.");
  await sendDraft(page);
  await expect(visibleTurn(page, "assistant")).toContainText("Synthetic sourced answer.");
  expect(requests).toHaveLength(1);
  expect(requests[0].webSearchMode).toBe("always");
  expect(requests[0].modelId).toBe(MODEL_ID);
  await expect(visibleTurn(page, "assistant").getByTestId("search-status-badge")).toHaveAttribute("data-search-status", "executed");
  const citation = visibleTurn(page, "assistant").getByTestId("search-citation-list").getByRole("link");
  await expect(citation).toHaveCount(1);
  await expect(citation).toHaveAttribute("href", source.url);
  await expect(citation).toContainText(source.title);
  await expect(citation).toHaveAttribute("rel", "noopener noreferrer");
  await finishEvidence(testInfo, "search", boundary, { requests, source });
});

test("generated file event renders a Chat card and downloads the synthetic bytes", async ({ page }, testInfo) => {
  const boundary = await installNetworkBoundary(page);
  await prepareAccount(page);
  const bytes = Buffer.from("Synthetic E03 generated document.\n", "utf8");
  const filename = "합성_E03.md";
  const artifact = {
    id: "art_synthetic_e03",
    ordinal: 0,
    format: "md" as const,
    filename,
    mediaType: "text/markdown",
    byteSize: bytes.length,
    status: "ready" as const,
    modelId: MODEL_ID,
  };
  const requests = await mockAnswer(page,
    buildArtifactProgressChunk("md") + "Synthetic file prepared." + buildChatStreamTrailerChunk({
      searchMetadata: null,
      completion: { status: "normal" },
      artifacts: [artifact],
    })
  );
  const downloads: Array<{ method: string; path: string }> = [];
  await page.route("**/api/artifacts/art_synthetic_e03", async (route) => {
    downloads.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/markdown",
        "Content-Disposition": `attachment; filename="synthetic-e03.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
      body: bytes,
    });
  });
  await page.goto("/chat");
  await page.getByTestId("chat-textarea").fill("Make a synthetic Markdown file.");
  await sendDraft(page);
  const card = visibleTurn(page, "assistant").getByTestId("generated-artifact-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-artifact-model", MODEL_ID);
  await expect(card).toHaveAttribute("data-artifact-format", "md");
  await expect(card.getByTestId("generated-artifact-filename")).toHaveText(filename);
  await expect(visibleTurn(page, "assistant")).toContainText("Synthetic file prepared.");
  await expect(visibleTurn(page, "assistant")).not.toContainText("TOMVERSE_");
  expect(requests).toHaveLength(1);
  expect(newestUser(requests[0]).content).toBe("Make a synthetic Markdown file.");
  expect(downloads).toHaveLength(0);
  const downloadPromise = page.waitForEvent("download");
  await card.getByTestId("generated-artifact-download").click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe(filename);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath!)).toEqual(bytes);
  expect(downloads).toEqual([{ method: "GET", path: "/api/artifacts/art_synthetic_e03" }]);
  await finishEvidence(testInfo, "file", boundary, { requests, artifact, downloads, downloadedBytes: bytes.length });
});
