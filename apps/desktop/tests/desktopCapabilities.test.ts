import assert from "node:assert/strict";
import test from "node:test";
import { readDesktopCapabilities } from "../src/host/desktop-capabilities";

test("Desktop accepts 2K image quotes and isolates an unsupported image catalogue from text capabilities", async (t) => {
  let size = "2048x2048";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    autoSelection: { offered: true }, desktopWrite: true, desktopAttachments: true,
    desktopReview: { easy: true, modelLimit: 3, plan: "Max" },
    desktopImages: { maxModels: 2, models: [{ id: "recraftv4_pro", name: "Recraft V4 Pro", provider: "recraft",
      pricingVersion: "fixture", prices: [{ size, quality: "high", credits: 350 }] }] },
  }));
  const load = () => readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  const supported = await load();
  assert.equal(supported?.images?.models[0].prices[0].size, size);
  assert.equal(supported?.review?.modelLimit, 3);
  size = "4096x4096";
  const invalid = await load();
  assert.equal(invalid?.images, null);
  assert.equal(invalid?.chatWrite, true);
  assert.equal(invalid?.attachments, true);
  assert.equal(invalid?.review?.modelLimit, 3);
});

test("what a turn may carry comes from the server that was reached, and an older server offers none of it", async (t) => {
  let body: Record<string, unknown> = { autoSelection: { offered: false }, desktopWrite: true, desktopPlugins: true, desktopComposerTools: true };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const load = () => readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  const older = await load();
  assert.deepEqual([older?.plugins, older?.composerTools], [true, true]);
  assert.deepEqual([older?.turnLocation, older?.chatPlugin, older?.reviewContext, older?.reviewTools], [false, false, false, false]);
  body = { ...body, desktopTurnLocation: true, desktopChatPlugin: true, desktopReviewContext: true, desktopReviewTools: true };
  const current = await load();
  assert.deepEqual([current?.turnLocation, current?.chatPlugin, current?.reviewContext, current?.reviewTools], [true, true, true, true]);
  // The "+" menu's choices reach a model through the Review turn's context, so they are not offered without it.
  body = { ...body, desktopReviewContext: false };
  assert.equal((await load())?.reviewTools, false);
});

test("plugins from a zip file, an npm package or a private repository are offered only where the server names them", async (t) => {
  let body: Record<string, unknown> = { autoSelection: { offered: false }, desktopPlugins: true };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const load = () => readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  // An older server names nothing, and the connector switch does not stand in for it.
  assert.deepEqual([(await load())?.plugins, (await load())?.pluginSources], [true, false]);
  body = { ...body, desktopPluginSources: false };
  assert.equal((await load())?.pluginSources, false);
  body = { ...body, desktopPluginSources: true, desktopPlugins: false };
  assert.deepEqual([(await load())?.plugins, (await load())?.pluginSources], [false, true]);
});

test("dictation and the voice conversation are offered only where Desktop's switch and the server's own voice switch are both on", async (t) => {
  let body: Record<string, unknown> = { autoSelection: { offered: false }, desktopWrite: true,
    voiceConversation: { enabled: true, maxSeconds: 300, continuous: true, reservationSeconds: 60 } };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const load = () => readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  // The web's voice setting alone opens nothing in Desktop.
  assert.deepEqual([(await load())?.voiceInput, (await load())?.voiceConversation], [false, null]);
  body = { ...body, desktopVoiceInput: true, desktopVoiceConversation: true };
  assert.deepEqual([(await load())?.voiceInput, (await load())?.voiceConversation], [true, { continuous: true, maxSeconds: 300 }]);
  body = { ...body, voiceConversation: { enabled: false, maxSeconds: 300 } };
  assert.equal((await load())?.voiceConversation, null);
  // A voice setting this build cannot read costs the conversation, not the rest of the capabilities.
  body = { ...body, voiceConversation: { enabled: "yes" } };
  const unread = await load();
  assert.deepEqual([unread?.voiceInput, unread?.voiceConversation, unread?.chatWrite], [true, null, true]);
});
