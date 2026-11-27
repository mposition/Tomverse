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
 *     `base-uri 'none'`, `frame-src 'none'`, `object-src 'none'`. Script and
 *     style may be inline or come from three public CDNs; images and fonts may
 *     be inline or from those CDNs. A page that wants anything else does not
 *     get it.
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

export const HTML_PREVIEW_CSP = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cdn}`,
    `style-src 'unsafe-inline' ${cdn}`,
    `img-src data: blob: ${cdn}`,
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

export const isHtmlPreviewable = (artifact: { format: string; byteSize: number; status: string }) =>
    artifact.status === "ready" && HTML_PREVIEW_FORMATS.has(artifact.format.toLowerCase());

export const isHtmlPreviewSmallEnough = (byteSize: number) =>
    Number.isFinite(byteSize) && byteSize >= 0 && byteSize <= HTML_PREVIEW_MAX_BYTES;

/** The page's own doctype, if it starts with one: ours replaces it. */
const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

/**
 * The document handed to the frame: our doctype, then the CSP `<meta>` as the
 * very first element, then the page exactly as the model wrote it.
 *
 * The policy is placed in front of the page rather than spliced into its
 * `<head>`: finding that tag by pattern can be fooled by a comment or a string
 * that contains "<head>", and then the policy would sit inside the comment.
 * In front of everything it is parsed first, whatever follows. The page's own
 * `<html>` and `<head>` tags still merge into the elements the parser already
 * made, and a policy the page adds itself can only narrow ours.
 */
export function buildHtmlPreviewSrcdoc(html: string): string {
    const page = html.replace(LEADING_DOCTYPE, "");
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">${page}`;
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
