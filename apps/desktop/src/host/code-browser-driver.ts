import { randomBytes } from "node:crypto";
import { nativeImage, type WebContents } from "electron";
import type { BrowserAgentReply } from "../../../tomverse-cli/src/browser-tools";
import type { ElementPick } from "../browser-contract";
import { describePickedFunction, elementBoxScript, focusScript, locateScript, readTextScript } from "./browser-agent-page";
import { formatAxTree, formatPageText, pushConsoleEntry, type AxNode, type ConsoleEntry } from "./browser-agent-format";
import { sameApprovedSite } from "./browser-agent-policy";
import { rememberPick } from "./browser-pick-store";

/**
 * Drives one local browser tab from the main process: page facts through scripts in an isolated world, and input, pictures, the
 * accessibility tree and the element picker through the tab's own DevTools session. No preload and nothing stays in the page.
 */

const WORLD = 2024;
const MAX_SHOT_BASE64 = 3_000_000;
const MAX_CLIP = 1600;

type Spot = { error: string } | { x: number; y: number; matches: number; tag: string; name: string };
type Box = { error: string } | { x: number; y: number; width: number; height: number };
type Described = { tag: string; selector: string; text: string; url: string; secret?: boolean;
  box: { x: number; y: number; width: number; height: number }; page: { x: number; y: number } };

/** A picture that is still too large as a JPEG is made smaller until it fits, so the model never receives more than the CLI takes. */
function shrinkJpeg(base64: string): string {
  let image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
  for (let attempt = 0; attempt < 6 && !image.isEmpty(); attempt += 1) {
    image = image.resize({ width: Math.max(1, Math.round(image.getSize().width * 0.7)) });
    const data = image.toJPEG(70).toString("base64");
    if (data.length <= MAX_SHOT_BASE64) return data;
  }
  return base64;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clamp = (value: number) => Math.max(1, Math.min(MAX_CLIP, Math.round(value)));

export function createBrowserDriver(contents: WebContents, tab: string, view: { size(): { width: number; height: number }; failed(): boolean }) {
  const entries: ConsoleEntry[] = [];
  let picking = false;
  let onPick: ((pick: ElementPick) => void) | undefined;
  let onPicking: (() => void) | undefined;
  contents.on("console-message", (event) => pushConsoleEntry(entries, event.level, event.message));

  const fail = (message: string): BrowserAgentReply => ({ status: "error", message });
  const ok = (extra: Partial<Extract<BrowserAgentReply, { status: "ok" }>> = {}): BrowserAgentReply =>
    ({ status: "ok", url: contents.getURL(), title: contents.getTitle(), ...extra });
  const evalPage = <T>(code: string) => contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>;
  const hidden = () => {
    const { width, height } = view.size();
    return width > 0 && height > 0 ? null : "The browser panel is hidden, so the page has no size. Ask the user to show it.";
  };
  const cdp = async <T = any>(method: string, params?: Record<string, unknown>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const session = contents.debugger;
    if (!session.isAttached()) {
      session.attach("1.3");
      // The tab is not focused by the person; the page should still behave as if it were.
      await session.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    }
    return await session.sendCommand(method, params) as T;
  };
  const waitStop = (ms: number) => new Promise<void>((resolve) => {
    if (!contents.isLoading()) { resolve(); return; }
    const done = () => { clearTimeout(timer); contents.off("did-stop-loading", done); resolve(); };
    const timer = setTimeout(done, ms);
    contents.on("did-stop-loading", done);
  });
  const settle = async () => { await sleep(150); await waitStop(5_000); await sleep(100); };
  const capture = async (clip?: { x: number; y: number; width: number; height: number }) => {
    const shot = async (format: "png" | "jpeg") => (await cdp<{ data: string }>("Page.captureScreenshot", {
      format, ...(format === "jpeg" ? { quality: 70 } : {}), ...(clip ? { clip: { ...clip, scale: 1 } } : {}), captureBeyondViewport: false,
    })).data;
    const png = await shot("png");
    if (png.length <= MAX_SHOT_BASE64) return { mediaType: "image/png" as const, base64: png };
    const jpeg = await shot("jpeg");
    return { mediaType: "image/jpeg" as const, base64: jpeg.length <= MAX_SHOT_BASE64 ? jpeg : shrinkJpeg(jpeg) };
  };

  const stopPicking = async () => {
    picking = false;
    if (!contents.debugger.isAttached()) return;
    await cdp("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(() => undefined);
    await cdp("Overlay.hideHighlight").catch(() => undefined);
  };
  const describePicked = async (backendNodeId: number) => {
    const { object } = await cdp<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId });
    if (!object.objectId) return;
    try {
      const result = await cdp<{ result: { value?: Described } }>("Runtime.callFunctionOn", {
        objectId: object.objectId, functionDeclaration: describePickedFunction, returnByValue: true });
      const info = result.result.value;
      if (!info || typeof info.selector !== "string") return;
      let thumbnail: string | undefined;
      const id = "pick-" + randomBytes(4).toString("hex");
      // No picture of a secret field, or of anything with one under it: the picture would go to a model with the person's message.
      const withheld = info.secret ? "secret" as const : info.box.width < 1 || info.box.height < 1 ? "empty" as const : undefined;
      if (!withheld) {
        const picture = await capture({ x: info.page.x, y: info.page.y, width: clamp(info.box.width), height: clamp(info.box.height) });
        rememberPick(id, { ...picture, url: info.url });
        const image = nativeImage.createFromBuffer(Buffer.from(picture.base64, "base64"));
        if (!image.isEmpty()) thumbnail = image.resize({ width: Math.min(240, image.getSize().width) }).toDataURL();
      }
      onPick?.({
        id, tab, ...(withheld ? { withheld } : {}), url: info.url.slice(0, 2048), selector: info.selector.slice(0, 500), tag: String(info.tag).slice(0, 40), text: String(info.text).slice(0, 160),
        box: { x: Math.round(info.box.x), y: Math.round(info.box.y), width: Math.round(info.box.width), height: Math.round(info.box.height) },
        ...(thumbnail && thumbnail.length < 200_000 ? { thumbnail } : {}),
      });
    } finally {
      await cdp("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
    }
  };
  contents.debugger.on("message", (_event, method, params: { backendNodeId?: number }) => {
    if (method !== "Overlay.inspectNodeRequested" || !picking || typeof params.backendNodeId !== "number") return;
    const backendNodeId = params.backendNodeId;
    void stopPicking().then(() => { onPicking?.(); return describePicked(backendNodeId); }).catch(() => undefined);
  });
  contents.debugger.on("detach", () => { picking = false; onPicking?.(); });

  return {
    /** Where picked elements and the end of the picking mode are reported. */
    listen(handlers: { pick: (pick: ElementPick) => void; picking: () => void }) { onPick = handlers.pick; onPicking = handlers.picking; },
    isPicking: () => picking,
    async setPicking(enabled: boolean) {
      if (!enabled) { await stopPicking(); return; }
      if (hidden() || view.failed()) return;
      await cdp("DOM.enable");
      await cdp("Overlay.enable");
      await cdp("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: {
        contentColor: { r: 111, g: 168, b: 220, a: 0.35 }, borderColor: { r: 111, g: 168, b: 220, a: 0.9 }, showInfo: true } });
      picking = true;
    },
    async waitForLoad(ms: number) { await waitStop(ms); },
    size: () => view.size(),
    where: () => ({ url: contents.getURL(), title: contents.getTitle() }),
    async read(mode: "text" | "tree", signal: AbortSignal): Promise<BrowserAgentReply> {
      if (view.failed()) return fail("The page could not be loaded.");
      if (mode === "tree") {
        const { nodes } = await cdp<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
        signal.throwIfAborted();
        return ok({ text: formatAxTree(nodes) });
      }
      const page = await evalPage<{ title: string; text: string; controls: string[] }>(readTextScript);
      signal.throwIfAborted();
      return ok({ text: formatPageText(page, contents.getURL()) });
    },
    async click(selector: string, origin: string, signal: AbortSignal): Promise<BrowserAgentReply> {
      if (!sameApprovedSite(origin, contents.getURL())) return fail("The page is no longer on the site the user approved. Nothing was done.");
      const refused = hidden();
      if (refused) return fail(refused);
      const spot = await evalPage<Spot>(locateScript(selector, false));
      signal.throwIfAborted();
      if ("error" in spot) return fail(spot.error);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
      await settle();
      return ok();
    },
    async type(input: { selector: string; origin: string; text: string; clear: boolean; submit: boolean }, signal: AbortSignal): Promise<BrowserAgentReply> {
      if (!sameApprovedSite(input.origin, contents.getURL())) return fail("The page is no longer on the site the user approved. Nothing was done.");
      const refused = hidden();
      if (refused) return fail(refused);
      const spot = await evalPage<Spot>(locateScript(input.selector, true));
      signal.throwIfAborted();
      if ("error" in spot) return fail(spot.error);
      if (!await evalPage<boolean>(focusScript(input.selector, input.clear))) return fail("The field could not be focused.");
      signal.throwIfAborted();
      if (input.text) await cdp("Input.insertText", { text: input.text });
      if (input.submit) {
        const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key });
      }
      await settle();
      return ok();
    },
    async screenshot(selector: string | undefined, signal: AbortSignal): Promise<BrowserAgentReply> {
      const refused = hidden();
      if (refused) return fail(refused);
      if (view.failed()) return fail("The page could not be loaded.");
      let clip: { x: number; y: number; width: number; height: number } | undefined;
      if (selector) {
        let box: Box;
        try { box = await evalPage<Box>(elementBoxScript(selector)); } catch { return fail("The selector is not valid CSS."); }
        signal.throwIfAborted();
        if ("error" in box) return fail(box.error);
        if (box.width < 1 || box.height < 1) return fail("The element has no visible area.");
        clip = { x: box.x, y: box.y, width: clamp(box.width), height: clamp(box.height) };
      }
      const picture = await capture(clip);
      signal.throwIfAborted();
      return ok({ image: picture });
    },
    console(clear: boolean): BrowserAgentReply {
      const found = entries.map((entry) => ({ ...entry }));
      if (clear) entries.length = 0;
      return ok({ entries: found });
    },
    dispose() {
      picking = false;
      onPick = undefined;
      onPicking = undefined;
      try { if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach(); } catch { /* Already gone. */ }
    },
  };
}
export type BrowserDriver = ReturnType<typeof createBrowserDriver>;
