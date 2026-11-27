/**
 * What it takes to show a model-written HTML page next to the chat without
 * giving it the chat's origin.
 *
 * Policy: docs/policy/generated-artifacts.md section 9, "HTML은 옆 패널에서
 * 미리 본다".
 *
 * A generated `.html` file is a page the model wrote. It may run script (that
 * is what "make me a chart" means), so the preview treats it as hostile code
 * that is allowed to compute and to draw, and as nothing else:
 *
 *   * `sandbox="allow-scripts"` and nothing more. In particular no
 *     `allow-same-origin`: the frame gets an opaque origin, so it cannot read
 *     this application's cookies, storage or DOM, and cannot call its APIs as
 *     the signed-in user. No `allow-top-navigation` (it cannot move the chat
 *     away), no `allow-popups`, `allow-forms`, `allow-modals`,
 *     `allow-downloads`.
 *   * The page arrives as `srcdoc`, never as a URL on this origin.
 *   * A Content-Security-Policy `<meta>` is the first thing in the document.
 *     It cuts the channels a sandboxed script would still have: `connect-src
 *     'none'` (no fetch, XHR, WebSocket, beacon), `form-action 'none'`,
 *     `base-uri 'none'`, `frame-src 'none'`, `object-src 'none'`. Script,
 *     style and fonts may be inline or come from three public CDNs (the
 *     libraries a chart or a map needs); images are inline only (`data:`,
 *     `blob:`), so a page cannot put text into an image URL and send it to a
 *     host. A page that wants anything else does not get it.
 *   * Not a guarantee against everything: a script may still navigate its own
 *     frame (CSP has no portable `navigate-to`). The panel counts the frame's
 *     loads and tears it down on the second one, so a page that leaves is shown
 *     a notice instead of a third-party site inside the chat.
 *
 * Pure and client-safe: strings only.
 */

export const HTML_PREVIEW_FORMATS: ReadonlySet<string> = new Set(["html", "htm"]);

/** Larger pages are downloaded, not previewed: the text is held in memory and in `srcdoc`. */
export const HTML_PREVIEW_MAX_BYTES = 1_000_000;

export const HTML_PREVIEW_SANDBOX = "allow-scripts";

/** Public CDNs a preview page may load script, style, fonts and images from. */
export const HTML_PREVIEW_CDN_HOSTS = [
    "https://cdnjs.cloudflare.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
] as const;

const cdn = HTML_PREVIEW_CDN_HOSTS.join(" ");

/** Where this application serves the files a preview may load from its own origin (public/vendor/artifact-preview). */
export const HTML_PREVIEW_VENDOR_PATH = "/vendor/artifact-preview/";

/** This application's origin as a CSP source, or null when it is not a plain http(s) origin. */
export const previewAssetOrigin = (origin: string | null | undefined) =>
    typeof origin === "string" && /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(origin) ? origin : null;

/**
 * The frame policy. With this application's origin it also admits the vendored
 * preview files under `HTML_PREVIEW_VENDOR_PATH` on that origin, and nothing
 * else of it (a `srcdoc` frame's own origin is opaque, so `'self'` would not).
 */
export const htmlPreviewCsp = (assetOrigin?: string | null) => {
    const origin = previewAssetOrigin(assetOrigin);
    const vendor = origin ? ` ${origin}${HTML_PREVIEW_VENDOR_PATH}` : "";
    return [
        "default-src 'none'",
        `script-src 'unsafe-inline' ${cdn}${vendor}`,
        `style-src 'unsafe-inline' ${cdn}`,
        "img-src data: blob:",
        `font-src data: ${cdn}`,
        "media-src data: blob:",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "worker-src 'none'",
        "manifest-src 'none'",
    ].join("; ");
};

export const HTML_PREVIEW_CSP = htmlPreviewCsp(null);

export const isHtmlPreviewable = (artifact: { format: string; byteSize: number; status: string }) =>
    artifact.status === "ready" && HTML_PREVIEW_FORMATS.has(artifact.format.toLowerCase());

export const isHtmlPreviewSmallEnough = (byteSize: number) =>
    Number.isFinite(byteSize) && byteSize >= 0 && byteSize <= HTML_PREVIEW_MAX_BYTES;

/** The page's own doctype, if it starts with one: ours replaces it. */
const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

/**
 * What the outer document says about its own frames: none. It is the whole of
 * the outer policy -- nothing else, because a `srcdoc` child inherits every
 * policy of its parent, and a `default-src` here would reach the page.
 */
export const HTML_PREVIEW_OUTER_CSP = "frame-src 'none'";

const attributeEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The page the user sees is a frame inside a frame.
 *
 * The inner document is the model's page, with our policy placed in front of
 * it (a policy spliced into its `<head>` by pattern could land inside a
 * comment; in front of everything it is parsed first). The outer document is
 * ours and contains nothing but that frame, and its policy is `frame-src
 * 'none'`: the browser checks every navigation of a frame against the
 * policy of the document that holds it, so a script that sets its own
 * `location` to an address of its choosing -- the one channel the page's
 * policy cannot close, because `navigate-to` was never shipped -- is refused
 * before a request leaves. The initial `srcdoc` load is not a network
 * navigation and is not affected.
 */
export function buildHtmlPreviewSrcdoc(html: string, assetOrigin?: string | null): string {
    const page = html.replace(LEADING_DOCTYPE, "");
    const inner = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${htmlPreviewCsp(assetOrigin)}">${page}`;
    return (
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_OUTER_CSP}">` +
        `<body style="margin:0;height:100vh;overflow:hidden">` +
        `<iframe sandbox="${HTML_PREVIEW_SANDBOX}" referrerpolicy="no-referrer" style="border:0;width:100%;height:100%" srcdoc="${attributeEscape(inner)}"></iframe>`
    );
}

/**
 * The app's own Content-Security-Policy, nonce and all, is inherited by a
 * `srcdoc` document. Under an enforced nonce policy the page's inline scripts
 * and styles would be blocked outright, so a preview built only from the
 * model's HTML would arrive unstyled and inert.
 *
 * The page's `<script>`, `<style>` and stylesheet `<link>` elements therefore
 * carry the embedding document's nonce. This does not widen what the page may
 * do: the frame is sandboxed without `allow-same-origin`, so the nonce lets a
 * script run inside the frame and nowhere else, and the policy in
 * `HTML_PREVIEW_CSP` still has to admit it as well (both policies apply).
 *
 * The browser's own HTML parser does the rewrite (`parse` is `DOMParser` in
 * the browser, injected so a test can run it) -- never a pattern over the
 * text. Inline event-handler attributes (`onclick="..."`) are not rewritten
 * and stay blocked under a nonce policy; `addEventListener` in a script works.
 * With no nonce (the embedding document has none) the page is returned as is.
 */
export function withEmbedderNonce(
    html: string,
    nonce: string | null | undefined,
    parse: (html: string) => { querySelectorAll: (selector: string) => ArrayLike<{ setAttribute: (name: string, value: string) => void }>; documentElement: { outerHTML: string } }
): string {
    if (!nonce || !/^[A-Za-z0-9+/_=-]{8,200}$/.test(nonce)) return html;
    const document = parse(html);
    for (const element of Array.from(document.querySelectorAll('script, style, link[rel~="stylesheet" i]'))) {
        element.setAttribute("nonce", nonce);
    }
    return document.documentElement.outerHTML;
}
