import type { Locator, Page, TestInfo } from "@playwright/test";

/**
 * What the E2E harness can and cannot drive, per engine.
 *
 * The mobile-safari project is the only WebKit one, and it is installed by a
 * single workflow (the daily security audit), so its results arrive rarely and
 * are read by someone who cannot reproduce them locally. When that project ran
 * for the first time in weeks on 2026-08-18, four specs failed on capability
 * errors rather than on anything the product did: a permission name WebKit does
 * not have, an input device it does not have, and a download the harness cannot
 * see.
 *
 * The rule this module exists to keep is that a missing *capability* must never
 * quietly become a missing *assertion*. Each helper below either drives the same
 * product behaviour by another route -- so the check still runs everywhere -- or
 * says exactly which observation is unavailable and leaves the rest of the test
 * asserting. None of them skips a test.
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
 * Whether a download started by *navigating* to an attachment response is
 * handled as a download on this project.
 *
 * Two download shapes exist in this product. A blob built in the page and
 * clicked through an `<a download>` raises Playwright's `download` event on
 * every engine -- the memory export proves it, passing on mobile-safari in the
 * same runs these failed. A `window.location.href` assignment to a route that
 * answers `Content-Disposition: attachment` is not saved on WebKit here: the
 * asserted evidence is that after the click `page.url()` was
 * `/api/conversations/qa-conversation/export`, so the engine rendered the
 * response rather than downloading it and the page went with it.
 *
 * That is the browser's disposition of a response, not the product's decision,
 * and it is only reachable through this harness -- what real Safari does with
 * the same response cannot be observed from here, and the response these tests
 * navigate to is a fulfilled mock rather than the server's own. So the
 * application's decision -- that the export route is requested, exactly once --
 * is asserted on every engine, and what the browser then does with the
 * attachment is asserted where this harness can see it.
 */
export function navigationDownloadsObservable(testInfo: TestInfo): boolean {
  return !testInfo.project.name.includes("safari");
}
