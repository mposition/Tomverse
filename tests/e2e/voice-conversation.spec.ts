import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, mockChatStream, openRecentConversation, prepareGuestPage } from "./support/app-fixtures";

type VoiceQa = {
  calls: Array<Record<string, unknown>>;
  stopped: number;
  emit: (event: unknown) => void;
};

async function installVoiceTransport(page: Page) {
  await page.addInitScript(() => {
    const scope = window as unknown as { __voiceConversationQa: VoiceQa };
    let output: ReadableStreamDefaultController<Uint8Array>;
    const qa: VoiceQa = { calls: [], stopped: 0, emit: event => output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) };
    scope.__voiceConversationQa = qa;
    const track = { enabled: true, stop: () => { qa.stopped++; } };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) });
    class Peer {
      iceGatheringState = "complete";
      localDescription: unknown = null;
      createOffer = async () => ({ type: "offer", sdp: "mock-offer" });
      setLocalDescription = async (value: unknown) => { this.localDescription = value; };
      setRemoteDescription = async () => {};
      addTrack() {} createDataChannel() {} close() {}
    }
    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: Peer });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/api/chat/voice") || init?.method !== "POST") return nativeFetch(input, init);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; qa.calls.push(body);
      if (body.action === "start") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        output = controller;
        qa.emit({ type: "ready", reservationId: "mock-reservation", sdp: "mock-answer", creditsPerMinute: 36, maxSeconds: 300 });
        qa.emit({ type: "started" });
      } }), { headers: { "Content-Type": "text/event-stream" } });
      if (body.action === "stop") { qa.emit({ type: "closed", confirmed: true, seconds: 10, credits: 6 }); output.close(); }
      return Response.json({ ok: true });
    };
  });
}

async function openVoice(page: Page, selectionMode: "manual" | "auto") {
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, {
    productKey: "chat", language: "en", selectedModels: ["gpt-5-6-luna"], selectionMode,
    autoSelectionOffered: selectionMode === "auto", webSearchMode: "always",
    messages: [{ id: "qa-user-existing", role: "user", content: "Existing conversation" }, { id: "qa-answer-existing", role: "assistant", content: "Existing answer", modelId: "gpt-5-6-luna" }],
  });
  await mockChatStream(page, "The saved backend answer with current sources.");
  await page.route("**/api/chat/context", route => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
  await page.route("**/api/assistant-profiles", route => route.fulfill({ json: { profiles: [] } }));
  await page.route("**/api/products/chat/capabilities", route => route.fulfill({ json: { autoSelection: { offered: selectionMode === "auto" } } }));
  await installVoiceTransport(page);
  await page.context().addCookies([
    { name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" },
    { name: "__tomverse_e2e_voice_conversation", value: "1", url: "http://127.0.0.1:3100" },
  ]);
  await page.goto("/chat?lang=en");
  await openRecentConversation(page, { title: "QA conversation" });
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await expect(page.getByTestId("voice-conversation-open")).toBeEnabled();
  await page.getByTestId("voice-conversation-open").click();
  await expect(page.getByRole("dialog", { name: "Voice conversation" })).toBeVisible();
}

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
test.setTimeout(90_000);
test.beforeEach(async ({}, info) => { test.skip(info.project.name !== "desktop-chromium", "Explicit mobile viewports on Chromium."); });

for (const mode of ["auto", "manual"] as const) test(`${mode} voice reuses Chat persistence, model selection and search`, async ({ page }) => {
  const chatRequests: Array<Record<string, unknown>> = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/chat" && request.method() === "POST") chatRequests.push(request.postDataJSON()); });
  await openVoice(page, mode);
  await expect(page.getByText("Voice: 36 credits/minute", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __voiceConversationQa: VoiceQa }).__voiceConversationQa.calls.length)).toBe(0);
  await page.getByRole("button", { name: "Start voice conversation", exact: true }).click();
  await expect(page.getByText("Listening · interrupt whenever you need")).toBeVisible();
  await page.evaluate(() => {
    const qa = (window as unknown as { __voiceConversationQa: VoiceQa }).__voiceConversationQa;
    qa.emit({ type: "transcript", event: { type: "session.input_transcript.delta", event_id: "u1", delta: "Please search for the latest information.", start_ms: 0, end_ms: 2_000 } });
    qa.emit({ type: "delegation", delegationId: "d1", text: "Please search for the latest information." });
  });
  await expect.poll(() => chatRequests.length).toBe(1);
  expect(chatRequests[0].webSearchMode).toBe("always");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __voiceConversationQa: VoiceQa }).__voiceConversationQa.calls.filter(c => c.action === "result").length)).toBe(1);
  const receipt = await page.evaluate(() => (window as unknown as { __voiceConversationQa: VoiceQa }).__voiceConversationQa.calls.find(c => c.action === "result"));
  expect(receipt?.conversationId).toBe("qa-conversation");
  expect(receipt?.sourceUserMessageId).toMatch(/^[a-f0-9-]{36}$/);
  expect(receipt).not.toHaveProperty("content");
  await page.getByRole("button", { name: "End conversation", exact: true }).click();
  await expect(page.getByText("Conversation ended", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __voiceConversationQa: VoiceQa }).__voiceConversationQa.stopped)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(page.getByText("The saved backend answer with current sources.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/conversation=qa-conversation/);
});

test("voice entry preserves the full-width composer and dialog controls at 320px and 200 percent text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openVoice(page, "manual");
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  const panel = page.getByTestId("voice-conversation-panel");
  await expect(panel).toBeVisible();
  const overflow = await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1);
  expect(overflow).toBe(false);
  await expect(page.getByRole("button", { name: "Start voice conversation", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const textarea = await page.getByTestId("chat-textarea").boundingBox();
  expect(textarea?.width).toBeGreaterThan(250);
});
