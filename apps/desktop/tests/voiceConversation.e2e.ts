import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const origin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
/** With this set, the run keeps pictures of the voice window for a person to look at. */
const shots = process.env.TOMVERSE_VOICE_SHOTS;

type VoiceFixture = {
  offer?: string;
  voice: Array<Record<string, unknown>>;
  saves: string[];
  turns: number;
  aborted: boolean;
  feed?: ReadableStreamDefaultController<Uint8Array>;
};
const fixtureState = (app: ElectronApplication) => app.evaluate(() => {
  const { offer, voice, saves, turns, aborted } = (globalThis as typeof globalThis & { voiceFixture: VoiceFixture }).voiceFixture;
  return { offer, voice, saves, turns, aborted };
});
/** One event of the session's stream, as the server writes it. */
const push = (app: ElectronApplication, event: Record<string, unknown>) => app.evaluate((_electron, value) => {
  const { feed } = (globalThis as typeof globalThis & { voiceFixture: VoiceFixture }).voiceFixture;
  feed!.enqueue(new TextEncoder().encode("data: " + JSON.stringify(value) + "\n\n"));
}, event);

/** A signed-in Chat on a faked server that offers the voice conversation. Nothing leaves this computer. */
async function launch() {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-voice-"));
  await writeFile(join(profile, "language.txt"), "en");
  const app = await electron.launch({ executablePath, timeout: 20_000,
    args: [desktopDir, "--user-data-dir=" + profile, "--use-fake-device-for-media-stream"] });
  await app.evaluate(({ shell }, fixtureOrigin) => {
    type VoiceFixture = {
      offer?: string; voice: Array<Record<string, unknown>>; saves: string[]; turns: number; aborted: boolean;
      feed?: ReadableStreamDefaultController<Uint8Array>;
    };
    const host = globalThis as typeof globalThis & { voiceFixture: VoiceFixture };
    host.voiceFixture = { voice: [], saves: [], turns: 0, aborted: false };
    const state = host.voiceFixture;
    const chat = { id: "voice-chat", title: "Voice fixture", kind: "chat", surface: "chat", productKey: "chat" };
    const messages: Array<Record<string, unknown>> = [];
    let created = false;
    const realFetch = globalThis.fetch;
    shell.openExternal = async (href) => {
      const target = new URL(href);
      if (target.origin !== fixtureOrigin || target.pathname !== "/auth/desktop") throw new Error("Unexpected browser destination.");
      const callback = new URL(target.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
      if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the fixture account.");
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== fixtureOrigin) return new Response(null, { status: 404 });
      const headers = new Headers(init?.headers);
      const path = "/api/conversations/" + chat.id;
      if (url.pathname === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
      if (url.pathname === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "voice-fixture", name: "Voice Fixture", email: "voice@example.test" } });
      if (url.pathname === "/api/products/chat/capabilities") {
        return Response.json({ autoSelection: { offered: false }, desktopWrite: true, desktopVoiceConversation: true,
          voiceConversation: { enabled: true, maxSeconds: 300, continuous: true, reservationSeconds: 60 } });
      }
      if (url.pathname === "/api/models/catalog") {
        return Response.json({ models: [{ id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai", minimumPlan: "Guest", publiclyListed: true, status: "enabled", enabled: true }] });
      }
      if (url.pathname === "/api/conversations") return Response.json(created ? [{ ...chat, selectedModels: ["gpt-6-luna"] }] : []);
      if (url.pathname === "/api/products/chat/conversations" && init?.method === "POST") { created = true; return Response.json({ id: chat.id }); }
      if (url.pathname === path && init?.method === "PATCH") return Response.json({ id: chat.id });
      if (url.pathname === path) {
        return Response.json({ ...chat, messages, selectedModels: ["gpt-6-luna"], messagePage: { nextCursor: null },
          selectionMode: "manual", autoSelection: { offered: false }, webSearchMode: "off" });
      }
      if (url.pathname === path + "/messages") {
        const [saved] = JSON.parse(String(init?.body)).messages;
        state.saves.push(saved.content);
        const id = "question-" + messages.length;
        messages.push({ id, role: "user", content: saved.content, status: "normal", createdAt: new Date(10_000 + messages.length).toISOString() });
        return Response.json({ messageMappings: [{ requestId: saved.clientRequestId, messageId: id }] });
      }
      if (url.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: null });
      if (url.pathname === "/api/chat") {
        const body = JSON.parse(String(init?.body));
        state.turns += 1;
        const reply = "Paris is the capital of France.";
        messages.push({ id: body.assistantMessageId, role: "assistant", modelId: body.modelId, content: reply, status: "normal",
          createdAt: new Date(20_000 + messages.length).toISOString() });
        return new Response(reply);
      }
      if (url.pathname === "/api/chat/voice") {
        if (init?.method !== "POST" || headers.get("origin") !== "tomverse://desktop" || headers.get("authorization") !== "Bearer fixture-access" ||
            headers.has("cookie")) return Response.json({ code: "VOICE_AUTHENTICATION_REQUIRED" }, { status: 401 });
        const body = JSON.parse(String(init.body));
        state.voice.push(body.action === "start" ? { ...body, sdp: "(offer)" } : body);
        if (body.action === "start") {
          state.offer = body.sdp;
          init.signal?.addEventListener("abort", () => { state.aborted = true; try { state.feed?.error(new Error("aborted")); } catch { /* already closed */ } });
          return new Response(new ReadableStream<Uint8Array>({ start(controller) { state.feed = controller; } }),
            { headers: { "Content-Type": "text/event-stream" } });
        }
        if (body.action === "stop") {
          state.feed?.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ type: "closed", confirmed: true, settled: true, seconds: 12, credits: 8 }) + "\n\n"));
          state.feed?.close();
        }
        if (body.action === "status") return Response.json({ settled: true, credits: 8, seconds: 12, confirmed: true });
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    };
  }, origin);
  const desktop = await app.firstWindow();
  await desktop.getByRole("button", { name: "Settings", exact: true }).click();
  await desktop.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
  await expect.poll(() => desktop.evaluate(async () => (await window.desktop.state()).account)).toMatchObject({ stage: "connected" });
  await desktop.getByRole("button", { name: "Chat", exact: true }).click();
  return { app, desktop, profile };
}

test("Chat holds a two-way voice conversation: the microphone opens for one session, the question takes the ordinary Send, and the saved answer is named back", { timeout: 120_000, skip: !origin }, async () => {
  const { app, desktop, profile } = await launch();
  try {
    const open = desktop.getByTestId("voice-conversation-open");
    const panel = desktop.getByTestId("voice-conversation-panel");
    // With an empty draft the voice button takes the Send button's place; typed words bring Send back.
    await expect(open).toBeVisible();
    await expect(desktop.getByRole("button", { name: "Send Chat message", exact: true })).toHaveCount(0);
    const message = desktop.getByRole("textbox", { name: "Chat message", exact: true });
    await message.fill("typed");
    await expect(open).toHaveCount(0);
    await expect(desktop.getByRole("button", { name: "Send Chat message", exact: true })).toBeVisible();
    await message.fill("");

    // The window cannot open the microphone by itself.
    const microphone = () => desktop.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    });
    await assert.rejects(microphone(), /NotAllowedError|Permission denied/);

    await open.click();
    await expect(panel).toHaveAttribute("data-voice-phase", "ready");
    await expect(panel).toContainText("GPT 6 Luna");
    await expect(panel).toContainText("initially up to 36");
    assert.equal((await fixtureState(app)).voice.length, 0, "opening the window starts nothing and charges nothing");
    if (shots) await desktop.screenshot({ path: join(shots, "voice-ready.png") });
    await panel.getByRole("button", { name: "Start voice conversation", exact: true }).click();
    await expect.poll(async () => (await fixtureState(app)).offer !== undefined, { timeout: 20_000 }).toBe(true);
    const started = await fixtureState(app);
    assert.deepEqual(started.voice, [{ action: "start", requestId: started.voice[0]!.requestId, conversationId: null, sdp: "(offer)" }]);
    assert.match(started.offer!, /m=audio/);
    assert.match(started.offer!, /m=application/, "the events channel is part of the offer");

    // The other end of the call is a second connection in the same window, which sends a tone back as the assistant's voice.
    const answer = await desktop.evaluate(`(async (sdp) => {
      const peer = new RTCPeerConnection();
      window.voiceAnswerPeer = peer;
      await peer.setRemoteDescription({ type: "offer", sdp });
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const out = audio.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      out.stream.getAudioTracks().forEach((track) => peer.addTrack(track, out.stream));
      await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== "complete") await new Promise((resolve) => peer.addEventListener("icegatheringstatechange", () => { if (peer.iceGatheringState === "complete") resolve(); }));
      return peer.localDescription.sdp;
    })(${JSON.stringify(started.offer)})`) as string;
    await push(app, { type: "ready", reservationId: "voice-r1", sdp: answer, creditsPerMinute: 36, continuous: true, maxSeconds: null, closeAfterSeconds: 60, closingSeconds: 30 });
    await push(app, { type: "started" });
    await expect(panel).toHaveAttribute("data-voice-phase", /listening|speaking/);
    // The call really connects inside the app window, under its content policy, and the assistant's audio plays without a prompt.
    await expect.poll(() => desktop.evaluate("window.voiceAnswerPeer.connectionState"), { timeout: 20_000 }).toBe("connected");
    await expect(panel.getByRole("button", { name: "Play assistant audio" })).toHaveCount(0);
    await expect(panel).toHaveAttribute("data-voice-phase", "speaking", { timeout: 15_000 });
    if (shots) await desktop.screenshot({ path: join(shots, "voice-speaking.png") });
    // That microphone was for this one session: a second request from the window is refused.
    await assert.rejects(microphone(), /NotAllowedError|Permission denied/);

    // What the voice heard is handed to the app, which sends it as a typed message is sent.
    await push(app, { type: "usage", seconds: 7, credits: 5 });
    await push(app, { type: "delegation", delegationId: "delegation-1", text: "What is the capital of France?" });
    await expect.poll(async () => (await fixtureState(app)).voice.some(({ action }) => action === "result")).toBe(true);
    const answered = await fixtureState(app);
    assert.deepEqual(answered.saves, ["What is the capital of France?"]);
    assert.equal(answered.turns, 1);
    // The receipt names the saved question. It carries no answer text: the server reads its own saved answer.
    assert.deepEqual(answered.voice.find(({ action }) => action === "result"),
      { action: "result", reservationId: "voice-r1", delegationId: "delegation-1", conversationId: "voice-chat", sourceUserMessageId: "question-0" });
    await expect(desktop.getByText("Paris is the capital of France.").first()).toBeAttached();
    await expect(message).toHaveValue("");
    await expect(panel).toBeVisible();

    // Ending the session: the server's closing event carries what it cost.
    await panel.getByRole("button", { name: "End conversation", exact: true }).click();
    await expect(panel).toHaveAttribute("data-voice-phase", "ended");
    await expect(panel).toContainText("Voice credits: 8");
    if (shots) await desktop.screenshot({ path: join(shots, "voice-ended.png") });
    assert.equal((await fixtureState(app)).voice.at(-1)!.action, "stop");
    assert.equal((await fixtureState(app)).aborted, false);
    await panel.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(desktop.getByText("What is the capital of France?").first()).toBeVisible();
    await assert.rejects(microphone(), /NotAllowedError|Permission denied/);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("signing out ends a voice session at once", { timeout: 120_000, skip: !origin }, async () => {
  const { app, desktop, profile } = await launch();
  try {
    await desktop.getByTestId("voice-conversation-open").click();
    const panel = desktop.getByTestId("voice-conversation-panel");
    await panel.getByRole("button", { name: "Start voice conversation", exact: true }).click();
    await expect.poll(async () => (await fixtureState(app)).offer !== undefined, { timeout: 20_000 }).toBe(true);
    await desktop.evaluate(() => window.desktop.signOut());
    await expect.poll(async () => (await fixtureState(app)).aborted).toBe(true);
    await expect.poll(async () => (await desktop.evaluate(() => window.desktop.state())).account.stage).not.toBe("connected");
    await expect(panel).toHaveCount(0);
    await expect(desktop.getByTestId("voice-conversation-open")).toHaveCount(0);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
