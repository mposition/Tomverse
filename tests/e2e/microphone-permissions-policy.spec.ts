import { expect, test } from "@playwright/test";

/**
 * The microphone Permissions-Policy, checked where it is actually enforced.
 *
 * ## Why this file exists beside tests/e2e/voice-input-composer.spec.ts
 *
 * That spec proves the recorder: it runs a real `MediaRecorder`, produces a
 * real container and posts real bytes. To do that deterministically it replaces
 * `navigator.mediaDevices.getUserMedia` with a function returning a synthetic
 * stream — which is a reasonable thing to stub, and is the reason it could not
 * have caught this. The browser checks `Permissions-Policy` *inside*
 * `getUserMedia`; a replacement never reaches that check, so a document served
 * with `microphone=()` passed that suite while being unable to open a
 * microphone at all.
 *
 * So this file stubs nothing on the device path. Chromium's fake capture device
 * supplies the audio, and every policy gate the real API applies still applies.
 * The two suites are not redundant: one proves the recorder given a stream, the
 * other proves a stream can be obtained.
 *
 * ## What is asserted
 *
 * 1. the real `/chat` document response allows the microphone for its own
 *    origin, and still disables everything else it disabled before;
 * 2. a real `getUserMedia` succeeds on that document and produces recordable
 *    audio;
 * 3. the same page fails when `microphone=()` is injected — without which (2)
 *    would pass on a browser that ignored the header entirely, and would prove
 *    nothing about the header at all.
 *
 * Costs nothing: no provider call, no paid turn, no chat request.
 */

/** Everything the header disabled before, and must keep disabling. */
const STILL_DISABLED = [
  "camera",
  "geolocation",
  "payment",
  "usb",
  "browsing-topics",
] as const;

/** Security headers that must survive an edit to the one beside them. */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["cross-origin-opener-policy", "same-origin-allow-popups"],
  ["x-permitted-cross-domain-policies", "none"],
];

// Chromium's own fake capture device, so `getUserMedia` below is the real one
// rather than a replacement. `--use-fake-ui-for-media-stream` answers the
// permission prompt. Neither flag bypasses `Permissions-Policy`, which is the
// gate under test.
//
// Top level rather than inside a describe: Playwright refuses `launchOptions`
// in a group because it would force a new worker mid-file.
//
// The whole file is Chromium-only. The header assertion is browser-independent
// -- one server, one header, every client sees the same bytes -- so running it
// on one project loses nothing, and the device half has no WebKit or Firefox
// equivalent to run.
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    // The pre-provisioned Chromium fallback the config documents, repeated
    // here because a top-level `use` replaces the config's `launchOptions`
    // rather than merging into it.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  },
});

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "needs Chromium's fake capture device"
);

test.describe("microphone Permissions-Policy", () => {
  test("the real chat document allows the microphone for its own origin only", async ({
    page,
  }) => {
    const response = await page.goto("/chat", { waitUntil: "domcontentloaded" });
    expect(response, "no response for /chat").toBeTruthy();

    const policy = response!.headers()["permissions-policy"];
    expect(policy, "the document carries no Permissions-Policy").toBeTruthy();

    // `self` and nothing else. `*` would allow any embedded third-party frame
    // to open the microphone, which is a different decision from the one Voice
    // needs.
    expect(policy).toContain("microphone=(self)");
    expect(policy).not.toMatch(/microphone=\(\s*\)/);
    expect(policy).not.toMatch(/microphone=\*/);

    for (const feature of STILL_DISABLED) {
      expect(
        policy,
        `${feature} must stay disabled by this header`
      ).toContain(`${feature}=()`);
    }

    for (const [header, value] of SECURITY_HEADERS) {
      expect(
        response!.headers()[header],
        `${header} must survive the Permissions-Policy edit`
      ).toBe(value);
    }
    expect(response!.headers()["strict-transport-security"]).toContain(
      "max-age="
    );
  });

  test.describe("with a real capture device", () => {
    test.skip(
      ({ browserName }) => browserName !== "chromium",
      "needs Chromium's fake capture device"
    );

    test("getUserMedia succeeds and records real audio", async ({
      page,
      context,
      baseURL,
    }) => {
      await context.grantPermissions(["microphone"], { origin: baseURL! });
      await page.goto("/chat", { waitUntil: "domcontentloaded" });

      // No stub anywhere: this is the browser's own `getUserMedia`, subject to
      // the header the previous test read off the wire.
      const result = await page.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          const recorder = new MediaRecorder(stream);
          const chunks: Blob[] = [];
          recorder.ondataavailable = (event) => chunks.push(event.data);
          const stopped = new Promise<void>((resolve) => {
            recorder.onstop = () => resolve();
          });
          recorder.start();
          await new Promise((resolve) => setTimeout(resolve, 400));
          recorder.stop();
          await stopped;
          const bytes = new Blob(chunks, { type: recorder.mimeType }).size;
          for (const track of stream.getTracks()) track.stop();
          return { ok: true as const, tracks: stream.getAudioTracks().length, bytes };
        } catch (error) {
          return {
            ok: false as const,
            name: (error as Error).name,
            message: (error as Error).message,
          };
        }
      });

      expect(
        result,
        "getUserMedia was refused on a document that should allow it"
      ).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.tracks).toBeGreaterThan(0);
        // A container with no audio in it would satisfy "did not throw".
        expect(result.bytes).toBeGreaterThan(0);
      }
    });

    test("injecting microphone=() makes the same page fail", async ({
      page,
      context,
      baseURL,
    }) => {
      // The reverse half. Without it, the test above passes on a browser that
      // ignores Permissions-Policy altogether, and proves nothing about the
      // header.
      await context.grantPermissions(["microphone"], { origin: baseURL! });
      await page.route("**/chat", async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const headers = { ...response.headers() };
        headers["permissions-policy"] = (
          headers["permissions-policy"] || ""
        ).replace("microphone=(self)", "microphone=()");
        await route.fulfill({ response, headers });
      });

      const response = await page.goto("/chat", {
        waitUntil: "domcontentloaded",
      });
      expect(response!.headers()["permissions-policy"]).toContain(
        "microphone=()"
      );

      const result = await page.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          for (const track of stream.getTracks()) track.stop();
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, name: (error as Error).name };
        }
      });

      expect(
        result.ok,
        "microphone=() did not stop getUserMedia -- this browser is not enforcing the header, so the positive test above proves nothing"
      ).toBe(false);
      if (!result.ok) expect(result.name).toBe("NotAllowedError");
    });
  });
});
