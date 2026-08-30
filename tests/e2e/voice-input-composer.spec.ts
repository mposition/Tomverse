import { expect, test, type Page } from "@playwright/test";

import {
  expectNoHorizontalOverflow,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  freezeAnimations,
  mockGuestUsage,
  restoreActiveConversation,
  setDeterministicTheme,
  suppressTransientUi,
} from "./support/chat-state-fixtures";

/**
 * Voice input in the composer: docs/policy/voice-input.md §1 and §8.3, and the
 * geometry contract in docs/ui-contracts/mobile-chat-composer.md.
 *
 * ## The two things this file exists to prove
 *
 * 1. **A recording never sends a message.** The transcript arrives in the
 *    draft and stops there. This is the feature's first invariant, and the
 *    only way to actually execute it is to record something and then assert
 *    that no chat request was made.
 * 2. **The microphone does not cost the textarea any width.** A new control in
 *    the composer is exactly the change the mobile contract's release-blocker
 *    list is written about, so the rectangles are measured here rather than
 *    eyeballed.
 *
 * ## The recorder is real; only the device and the server are not
 *
 * `getUserMedia` is replaced with a synthetic `MediaStream` — an oscillator
 * through a `MediaStreamDestination` — so the page runs its own real
 * `MediaRecorder`, produces a real container and posts real bytes. Stubbing
 * `MediaRecorder` itself would leave the part most likely to break untested.
 */

const VOICE_ENDPOINT = "**/api/chat/voice-transcription";

/** Replaces the microphone with a tone. Everything downstream stays real. */
const installFakeMicrophone = async (page: Page) => {
  await page.addInitScript(() => {
    const state = {
      denied: false,
      unsupported: false,
      /** Tracks handed out, so a spec can prove they were stopped. */
      openTracks: 0,
    };
    (window as unknown as { __qaVoice: typeof state }).__qaVoice = state;

    const original = navigator.mediaDevices?.getUserMedia?.bind(
      navigator.mediaDevices
    );
    void original;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (state.denied) {
            const error = new Error("Permission denied");
            error.name = "NotAllowedError";
            throw error;
          }
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          oscillator.frequency.value = 440;
          const destination = context.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          const stream = destination.stream;
          for (const track of stream.getTracks()) {
            state.openTracks++;
            const stop = track.stop.bind(track);
            track.stop = () => {
              state.openTracks--;
              stop();
            };
          }
          return stream;
        },
      },
    });
  });
};

/** Makes the browser report that it cannot record at all. */
const installUnsupportedRecorder = async (page: Page) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: undefined,
    });
  });
};

type VoiceServer = {
  requests: Array<{ contentType: string | null; byteLength: number }>;
};

const mockVoiceEndpoint = async (
  page: Page,
  responder: (request: { byteLength: number }) => {
    status: number;
    body: Record<string, unknown>;
  } = () => ({ status: 200, body: { transcript: "안녕하세요 오늘 날씨 알려줘" } })
): Promise<VoiceServer> => {
  const server: VoiceServer = { requests: [] };
  await page.route(VOICE_ENDPOINT, async (route) => {
    const buffer = route.request().postDataBuffer();
    const byteLength = buffer?.byteLength ?? 0;
    server.requests.push({
      contentType: route.request().headers()["content-type"] ?? null,
      byteLength,
    });
    const { status, body } = responder({ byteLength });
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(body),
    });
  });
  return server;
};

/**
 * Opens the composer with voice input switched on.
 *
 * The cookie is the fixture-mode override the shell honours in place of the
 * flag *and* the session, which is the only way to reach the control with the
 * database disabled (components/chat/ReviewWorkspaceShell.tsx).
 */
const openComposerWithVoice = async (page: Page) => {
  await prepareGuestPage(page, "ko");
  await mockGuestUsage(page, 0, 20);
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await installFakeMicrophone(page);
  await restoreActiveConversation(page);
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_voice_input",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await freezeAnimations(page);
};

/** Records for `ms` and waits for the flow to settle. */
const recordFor = async (page: Page, ms: number) => {
  await page.getByTestId("composer-voice-button").click();
  await expect(page.getByTestId("voice-input-status-row")).toBeVisible();
  await page.waitForTimeout(ms);
  await page.getByTestId("composer-voice-button").click();
};

test.describe("voice input in the composer", () => {
  test("a transcript lands in the draft and is never sent @ui-risk", async ({
    page,
  }) => {
    await openComposerWithVoice(page);
    const voiceServer = await mockVoiceEndpoint(page);

    // The invariant. Any chat request at all during this test is a failure,
    // so it is recorded rather than mocked away.
    const chatRequests: string[] = [];
    await page.route("**/api/chat", async (route) => {
      chatRequests.push(route.request().method());
      await route.abort();
    });

    await recordFor(page, 1200);

    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toHaveValue("안녕하세요 오늘 날씨 알려줘", {
      timeout: 15_000,
    });
    expect(voiceServer.requests).toHaveLength(1);
    expect(voiceServer.requests[0].contentType).toMatch(/^audio\/(webm|mp4)$/);
    expect(voiceServer.requests[0].byteLength).toBeGreaterThan(2048);

    // The message was not sent, and nothing is waiting to send it.
    expect(chatRequests).toEqual([]);
    await expect(page.getByTestId("voice-input-status-row")).toHaveCount(0);
    // And the user can still edit what they "said" before sending.
    await textarea.fill("안녕하세요 내일 날씨 알려줘");
    await expect(textarea).toHaveValue("안녕하세요 내일 날씨 알려줘");
    expect(chatRequests).toEqual([]);
  });

  test("a transcript is appended to what was already typed", async ({ page }) => {
    await openComposerWithVoice(page);
    await mockVoiceEndpoint(page, () => ({
      status: 200,
      body: { transcript: "말한 부분" },
    }));

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("타이핑한 부분");
    await recordFor(page, 1200);

    await expect(textarea).toHaveValue("타이핑한 부분 말한 부분", {
      timeout: 15_000,
    });
  });

  test("cancelling never reaches the server and releases the microphone", async ({
    page,
  }) => {
    await openComposerWithVoice(page);
    const voiceServer = await mockVoiceEndpoint(page);

    await page.getByTestId("composer-voice-button").click();
    await expect(page.getByTestId("voice-input-status-row")).toBeVisible();
    await page.waitForTimeout(800);
    await page.getByTestId("voice-input-cancel").click();

    await expect(page.getByTestId("voice-input-status-row")).toHaveCount(0);
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    // Give a late `dataavailable` every chance to arrive and be dropped.
    await page.waitForTimeout(1000);
    expect(
      voiceServer.requests,
      "a cancelled recording must never leave the device"
    ).toEqual([]);

    // The browser's recording indicator is driven by live tracks; a flow that
    // leaves one open looks, to the user, like the product is still listening.
    const openTracks = await page.evaluate(
      () => (window as unknown as { __qaVoice: { openTracks: number } }).__qaVoice.openTracks
    );
    expect(openTracks).toBe(0);
  });

  test("a denied microphone explains itself and offers a way out", async ({
    page,
  }) => {
    await openComposerWithVoice(page);
    const voiceServer = await mockVoiceEndpoint(page);
    await page.evaluate(() => {
      (window as unknown as { __qaVoice: { denied: boolean } }).__qaVoice.denied = true;
    });

    await page.getByTestId("composer-voice-button").click();

    const error = page.getByTestId("voice-input-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute(
      "data-voice-error-code",
      "VOICE_PERMISSION_DENIED"
    );
    expect(voiceServer.requests).toEqual([]);

    await page.getByTestId("voice-input-error-dismiss").click();
    await expect(error).toHaveCount(0);
    // Dismissing returns the composer to a usable state rather than a dead one.
    await expect(page.getByTestId("composer-voice-button")).toBeEnabled();
  });

  test("a browser that cannot record says so instead of failing silently", async ({
    page,
  }) => {
    await installUnsupportedRecorder(page);
    await openComposerWithVoice(page);

    await page.getByTestId("composer-voice-button").click();

    await expect(page.getByTestId("voice-input-error")).toHaveAttribute(
      "data-voice-error-code",
      "VOICE_UNSUPPORTED_BROWSER"
    );
  });

  test("a server refusal is explained with its own sentence", async ({ page }) => {
    await openComposerWithVoice(page);
    await mockVoiceEndpoint(page, () => ({
      status: 429,
      body: { code: "VOICE_OPERATIONAL_LIMIT_REACHED" },
    }));

    await recordFor(page, 1200);

    const error = page.getByTestId("voice-input-error");
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(error).toHaveAttribute(
      "data-voice-error-code",
      "VOICE_OPERATIONAL_LIMIT_REACHED"
    );
    // The draft is untouched: a refusal must not put anything in the box.
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
  });

  test("a clip with no speech is reported as that, not as a generic failure", async ({
    page,
  }) => {
    await openComposerWithVoice(page);
    await mockVoiceEndpoint(page, () => ({
      status: 422,
      body: { code: "VOICE_TRANSCRIPT_EMPTY" },
    }));

    await recordFor(page, 1200);

    await expect(page.getByTestId("voice-input-error")).toHaveAttribute(
      "data-voice-error-code",
      "VOICE_TRANSCRIPT_EMPTY",
      { timeout: 15_000 }
    );
  });

  test("with the flag off there is no microphone at all", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockGuestUsage(page, 0, 20);
    await suppressTransientUi(page);
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    // Not a disabled control: a visible microphone that refuses would be
    // advertising a feature this deployment has deliberately not turned on
    // (docs/policy/voice-input.md §3).
    await expect(page.getByTestId("composer-voice-button")).toHaveCount(0);
    await expect(page.getByTestId("voice-input-status-row")).toHaveCount(0);
  });
});

/**
 * The composer contract, re-measured with the microphone present.
 *
 * docs/ui-contracts/mobile-chat-composer.md's release-blocker list: the
 * textarea owns a full-width row, nothing intersects it, and the composer does
 * not scroll sideways. A new control in the actions row is exactly the change
 * that list exists for, so it is measured at the contract's own viewports
 * rather than assumed to be fine because it looked fine at one width.
 *
 * Runs on desktop-chromium with `hasTouch`, the same way
 * `mobile-composer-contract.spec.ts` does: one engine, explicit viewports, and
 * `useIsMobileShell()` needs a coarse pointer as well as a narrow width.
 */
test.describe("the microphone does not break the composer's geometry", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Geometry is measured on one engine at explicit viewports."
    );
  });

  for (const width of [320, 360, 390, 430]) {
    test(`the textarea keeps its own full-width row at ${width}px @ui-risk`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 780 });
      await openComposerWithVoice(page);

      const textarea = page.getByTestId("chat-textarea");
      const microphone = page.getByTestId("composer-voice-button");
      await expect(microphone).toBeVisible();

      const [textareaBox, microphoneBox, rowBox] = await Promise.all([
        textarea.boundingBox(),
        microphone.boundingBox(),
        page.getByTestId("composer-textarea-row").boundingBox(),
      ]);
      expect(textareaBox).not.toBeNull();
      expect(microphoneBox).not.toBeNull();
      expect(rowBox).not.toBeNull();

      // Zero intersection with the input, which is the invariant.
      const overlapWidth = Math.max(
        0,
        Math.min(textareaBox!.x + textareaBox!.width, microphoneBox!.x + microphoneBox!.width) -
          Math.max(textareaBox!.x, microphoneBox!.x)
      );
      const overlapHeight = Math.max(
        0,
        Math.min(textareaBox!.y + textareaBox!.height, microphoneBox!.y + microphoneBox!.height) -
          Math.max(textareaBox!.y, microphoneBox!.y)
      );
      expect(overlapWidth * overlapHeight).toBe(0);

      // The textarea still owns essentially all of its row's width.
      expect(textareaBox!.width).toBeGreaterThanOrEqual(rowBox!.width * 0.9);
      // And at least one complete line.
      expect(textareaBox!.height).toBeGreaterThanOrEqual(36);

      // The 44px touch floor.
      expect(microphoneBox!.height).toBeGreaterThanOrEqual(44);
      expect(microphoneBox!.width).toBeGreaterThanOrEqual(44);

      // Send is still inside the composer rather than clipped out of it.
      await expect(page.getByTestId("chat-send-button")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }

  test("a running recording does not narrow the textarea @ui-risk", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await openComposerWithVoice(page);
    await mockVoiceEndpoint(page);

    const textarea = page.getByTestId("chat-textarea");
    const before = await textarea.boundingBox();

    await page.getByTestId("composer-voice-button").click();
    await expect(page.getByTestId("voice-input-status-row")).toBeVisible();

    const during = await textarea.boundingBox();
    expect(during!.width).toBeCloseTo(before!.width, 0);
    expect(during!.x).toBeCloseTo(before!.x, 0);
    expect(during!.height).toBeGreaterThanOrEqual(36);

    // The status row is above the input, never over it.
    const statusBox = await page.getByTestId("voice-input-status-row").boundingBox();
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(during!.y + 1);
    await expectNoHorizontalOverflow(page);

    await page.getByTestId("voice-input-cancel").click();
  });

  test("Korean IME composition survives a recording starting @ui-risk", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await openComposerWithVoice(page);
    await mockVoiceEndpoint(page);

    const textarea = page.getByTestId("chat-textarea");
    await textarea.click();
    await textarea.fill("안녕하세요 반갑습니다");
    const before = await textarea.boundingBox();

    await page.getByTestId("composer-voice-button").click();
    await expect(page.getByTestId("voice-input-status-row")).toBeVisible();

    // The committed text is intact, the box has not moved, and nothing is
    // scrolled out of sight.
    await expect(textarea).toHaveValue("안녕하세요 반갑습니다");
    const after = await textarea.boundingBox();
    expect(after!.width).toBeCloseTo(before!.width, 0);
    expect(after!.x).toBeCloseTo(before!.x, 0);

    const scroll = await textarea.evaluate((element) => ({
      overflow:
        (element as HTMLTextAreaElement).scrollHeight -
        (element as HTMLTextAreaElement).clientHeight,
      left: (element as HTMLTextAreaElement).scrollLeft,
    }));
    expect(scroll.overflow).toBeLessThanOrEqual(1);
    expect(scroll.left).toBe(0);

    await page.getByTestId("voice-input-cancel").click();
  });
});
