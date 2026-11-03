import type { Locator, Page } from "@playwright/test";

/**
 * What the E2E harness can and cannot drive, per engine.
 *
 * The mobile-safari project is the only WebKit one, and it is installed by a
 * single workflow (the daily security audit), so its results arrive rarely and
 * are read by someone who cannot reproduce them locally. When that project ran
 * for the first time in weeks on 2026-08-18, four specs failed on capability
 * errors rather than on anything the product did: a permission name WebKit does
 * not have, an input device it does not have, and two downloads it rendered
 * instead of saving.
 *
 * The rule this module exists to keep is that a missing *capability* must never
 * quietly become a missing *assertion*. Each helper below drives the same
 * product behaviour by another route, so the check still runs everywhere. None
 * of them skips a test.
 *
 * The downloads left: `navigationDownloadsObservable` lived here while the two
 * exports reached their route by assigning `location.href`, and it went when
 * they stopped. They now fetch the response and save the blob themselves
 * (lib/browserDownload.ts), which every engine reports as a download -- so
 * there is nothing engine-shaped left to describe, and their specs assert the
 * file on every project.
 */

/**
 * Grants clipboard access where the concept exists, and reports whether reading
 * the clipboard back is possible.
 *
 * `clipboard-read`/`clipboard-write` are Chromium permissions. WebKit has no
 * equivalent to grant -- it gates `writeText` on a user gesture instead -- and
 * Playwright rejects the names outright rather than ignoring them, which is how
 * this failed a test on its third line, before a single assertion had run.
 */
export async function grantClipboardAccess(page: Page): Promise<boolean> {
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    return true;
  } catch (error) {
    if (!/Unknown permission/i.test(String(error))) throw error;
    return false;
  }
}

declare global {
  interface Window {
    __qaClipboardWrites?: string[];
  }
}

/**
 * Records every string the page hands to `navigator.clipboard.writeText`, and
 * still lets it through.
 *
 * The text a copy control writes is the product's decision and can be checked on
 * every engine; whether the OS clipboard then returns it is the browser's, and
 * only Chromium will hand it back to a test here. Delegating rather than
 * replacing keeps the real write in the path, so a rejected write still shows up
 * as the failure toast it is.
 */
export async function recordClipboardWrites(page: Page) {
  await page.addInitScript(() => {
    const writes: string[] = [];
    window.__qaClipboardWrites = writes;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    const write = clipboard.writeText.bind(clipboard);
    clipboard.writeText = async (text: string) => {
      writes.push(text);
      return write(text);
    };
  });
}

/** The strings written to the clipboard since the document was created. */
export async function clipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__qaClipboardWrites ?? []);
}

/**
 * Scrolls a scroller up the way a user would, on whichever engine is running.
 *
 * Mobile WebKit has no wheel: Playwright refuses `mouse.wheel` there instead of
 * emulating it. The distinction does not reach the product -- ChatMessageList
 * interprets scrolling in exactly one place, the container's native `scroll`
 * event, and tells its own scrolls from everyone else's with a ref rather than
 * by inspecting the device (see components/chat/ChatMessageList.tsx). Wheel,
 * trackpad, swipe, scrollbar drag and keyboard paging all arrive there
 * identically, and so does this.
 *
 * The wheel is still used wherever it exists, so the common projects keep
 * exercising a real input device; only the engine that has none falls back, and
 * only on its own documented refusal -- any other failure is rethrown.
 */
export async function scrollUpBy(target: Locator, pixels: number) {
  const page = target.page();
  const box = await target.boundingBox();
  if (!box) throw new Error("scroll target is not visible");
  try {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -pixels);
    return;
  } catch (error) {
    if (!/wheel is not supported/i.test(String(error))) throw error;
  }
  await target.evaluate((element, amount) => {
    element.scrollTop -= amount;
  }, pixels);
}

/**
 * An element's layout box, measured by the page rather than by the protocol.
 *
 * `locator.boundingBox()` on WebKit asks the inspector for content quads and
 * answers `null` when that call fails, without saying why. On the audit's
 * Linux WebKit it did so for elements well below the fold -- the landing hero
 * capture and a CTA at a 320px viewport, run 39345904342, all three attempts --
 * while the snapshot of the same moment shows both attached and laid out, and
 * the same specs pass on Windows WebKit and on Chromium. A `null` there is a
 * missing capability, not a missing element, so these specs measure through
 * `getBoundingClientRect()`, which is what the viewport assertions are about.
 * The coordinates are the same viewport-relative CSS pixels either way.
 *
 * Throws if the element has no box at all, so "not rendered" still fails. A
 * box is not visibility -- `visibility: hidden` still has one -- so callers
 * assert `toBeVisible()` first, which `boundingBox()`'s null used to imply.
 */
export async function layoutBox(target: Locator) {
  const box = await target.evaluate((element) => {
    if (element.getClientRects().length === 0) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!box) throw new Error("element has no layout box");
  return box;
}

type HarnessCoordinates = { latitude: number; longitude: number; accuracy?: number };

/**
 * Puts the browser at `coordinates` through the engine's own geolocation, and
 * returns a function that moves it.
 *
 * `context.setGeolocation()` plus a granted permission is how Playwright fakes a
 * position. Chromium reports it with an epoch-millisecond `timestamp`, as the
 * spec says. Playwright's WebKit reports the same fix 1000x too large
 * (1793242133294000 against a `Date.now()` of 1793242133834 on Windows WebKit;
 * the audit's Linux WebKit fails the same four specs with the same screen), so
 * the product's `parseChatLocation` reads it
 * as a fix from the future and refuses it, and every chat-location spec got
 * "Current location is unavailable" on mobile-safari from the night the feature
 * ran (2026-10-25). Real Safari takes its timestamp from the device, not from
 * this override.
 *
 * So the engine's own `getCurrentPosition` still answers, permission prompt,
 * denial and timeout included; only a timestamp that is plainly in the wrong
 * unit (more than 100x the clock) is scaled back to milliseconds before the
 * page sees it. The product's freshness and range checks then run on it
 * unchanged.
 */
export async function provideGeolocation(page: Page, coordinates: HarnessCoordinates) {
  const context = page.context();
  const moveTo = (next: HarnessCoordinates) => context.setGeolocation(next);
  await context.grantPermissions(["geolocation"]);
  await moveTo(coordinates);
  await page.addInitScript(() => {
    const native = navigator.geolocation;
    if (!native) return;
    const getCurrentPosition = native.getCurrentPosition.bind(native);
    Object.defineProperty(native, "getCurrentPosition", {
      configurable: true,
      value: (
        success: PositionCallback,
        failure?: PositionErrorCallback | null,
        options?: PositionOptions
      ) =>
        getCurrentPosition(
          (position) => {
            if (position.timestamp <= Date.now() * 100) return success(position);
            success({
              coords: position.coords,
              timestamp: Math.round(position.timestamp / 1000),
            } as GeolocationPosition);
          },
          failure,
          options
        ),
    });
  });
  return moveTo;
}
