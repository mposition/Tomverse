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

/**
 * The only files under that path a frame may load, named one by one (the
 * React preview's three libraries, lib/chatArtifactPreview.ts). The policy
 * lists each file rather than the directory, so a file added there later is
 * not reachable from a model's page until it is added here. The integrity
 * hash stays on the `<script>` element: a hash in the policy itself would make
 * the browser ignore `'unsafe-inline'`, and a model's page runs inline script.
 */
export const HTML_PREVIEW_VENDOR_FILES = [
    "react-18.3.1.production.min.js",
    "react-dom-18.3.1.production.min.js",
    "babel-standalone-7.26.2.min.js",
] as const;

/** This application's origin as a CSP source, or null when it is not a plain http(s) origin. */
export const previewAssetOrigin = (origin: string | null | undefined) =>
    typeof origin === "string" && /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(origin) ? origin : null;

/**
 * The frame policy. With this application's origin it also admits the three
 * vendored preview files, by exact URL, and nothing else of that origin (a
 * `srcdoc` frame's own origin is opaque, so `'self'` would not).
 */
export const htmlPreviewCsp = (assetOrigin?: string | null) => {
    const origin = previewAssetOrigin(assetOrigin);
    const vendor = origin
        ? HTML_PREVIEW_VENDOR_FILES.map((file) => ` ${origin}${HTML_PREVIEW_VENDOR_PATH}${file}`).join("")
        : "";
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
        // CSP3's WebRTC switch. No shipping browser enforces it yet (measured: Chromium 159 still sends STUN; the
        // Firefox and WebKit bugs are open), and an unknown directive is ignored rather than voiding the policy, so it
        // costs nothing now and applies the day it ships. Until then HTML_PREVIEW_GUARD_SCRIPT is what stops WebRTC.
        "webrtc 'block'",
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
 * The WebRTC names a page could open a connection through. CSP's
 * `connect-src` does not cover WebRTC: a page could put text into a STUN or
 * TURN request to any host and port (measured in Chromium). Every global whose
 * name starts with RTC, webkitRTC or mozRTC is locked too, so a name added to
 * the platform later is covered without editing this list.
 */
export const HTML_PREVIEW_WEBRTC_GLOBALS = [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "mozRTCPeerConnection",
    "RTCDataChannel",
    "RTCSessionDescription",
    "RTCIceCandidate",
    "RTCRtpSender",
    "RTCRtpReceiver",
    "RTCRtpTransceiver",
    "RTCDtlsTransport",
    "RTCIceTransport",
    "RTCSctpTransport",
    "MediaStreamTrack",
    "MediaStream",
    "MediaDevices",
] as const;

/**
 * Runs in the preview frame before anything the page says (it follows only our
 * policy `<meta>`), and takes WebRTC out of the frame:
 *
 *   * each name above, and every other RTC global, becomes a non-writable,
 *     non-configurable `undefined` on the window, and so do
 *     `navigator.mediaDevices`, the legacy `getUserMedia` names and the
 *     capture methods of `MediaDevices.prototype` -- the page cannot delete or
 *     redefine them;
 *   * a nested frame would be a fresh window with its own constructors, so
 *     every frame-like element is removed as soon as it is inserted (a
 *     mutation observer, which runs before a nested document can load), and
 *     `contentWindow`/`contentDocument` are locked to `undefined`;
 *   * the observer has to see every tree a frame can be inserted into, and a
 *     shadow root is not part of the document's tree. So every shadow root in
 *     the frame is open, and the observer follows open roots: for each added
 *     element and its descendants that have a `shadowRoot`, it watches that
 *     root, removes its frames and does the same inside it (nested roots, and
 *     the roots the parser makes from the page's markup, whose host it sees
 *     added). `attachShadow` is replaced, non-configurably, by a wrapper that
 *     reads the options once, makes the root open -- a clonable closed root's
 *     copy is made without `attachShadow` and would be out of reach (measured)
 *     -- and follows it at once, since attaching to a host already in place
 *     records no mutation. The page's markup is parsed before any script, so
 *     its closed declarative roots are made open in the text
 *     (openDeclarativeShadowRoots). What stays locked is what makes a root
 *     from a string at run time, which that text pass never sees: the
 *     declarative-shadow-DOM parsers (`setHTMLUnsafe`, `setHTML`,
 *     `Document.parseHTMLUnsafe`, `Document.parseHTML`) and
 *     `document.write`/`writeln`, whose parser makes declarative roots too
 *     and can be fed an attribute split across calls (both measured). The
 *     other ways to a fresh realm are closed elsewhere: popups by the sandbox,
 *     workers by `worker-src 'none'`, navigating to another document by the
 *     outer document's `frame-src 'none'`.
 *
 * The observer uses only functions captured here, before the page runs, so a
 * page that replaces `Element.prototype.matches`, `NodeList.prototype.length`
 * or `Reflect.apply` afterwards cannot blind it. No backslashes and no closing
 * script tag, so it is the same text in source, in `srcdoc` and at runtime.
 */
export const HTML_PREVIEW_GUARD_SCRIPT = `(function () {
  var apply = Reflect.apply, define = Object.defineProperty, describe = Object.getOwnPropertyDescriptor;
  var lock = function (target, name) {
    if (!target) return;
    try { define(target, name, { value: undefined, writable: false, enumerable: false, configurable: false }); } catch (error) {}
  };
  var capture = ["getUserMedia", "getDisplayMedia", "enumerateDevices", "getSupportedConstraints", "selectAudioOutput", "setCaptureHandleConfig"];
  for (var c = 0; c < capture.length; c++) lock(window.MediaDevices && window.MediaDevices.prototype, capture[c]);
  var names = ${JSON.stringify(HTML_PREVIEW_WEBRTC_GLOBALS)};
  var own = Object.getOwnPropertyNames(window);
  for (var i = 0; i < own.length; i++) { if (/^(webkit|moz)?RTC/.test(own[i])) names.push(own[i]); }
  for (var j = 0; j < names.length; j++) lock(window, names[j]);
  var media = ["mediaDevices", "getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"];
  for (var k = 0; k < media.length; k++) { lock(Navigator.prototype, media[k]); lock(navigator, media[k]); }
  var holders = ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement", "HTMLEmbedElement"];
  for (var h = 0; h < holders.length; h++) {
    var holder = window[holders[h]];
    if (holder) { lock(holder.prototype, "contentWindow"); lock(holder.prototype, "contentDocument"); }
  }
  var parsers = [[Element.prototype, "setHTMLUnsafe"], [Element.prototype, "setHTML"], [window.Document, "parseHTMLUnsafe"],
    [window.Document, "parseHTML"], [Document.prototype, "write"], [Document.prototype, "writeln"]];
  if (window.ShadowRoot) parsers.push([ShadowRoot.prototype, "setHTMLUnsafe"], [ShadowRoot.prototype, "setHTML"]);
  for (var q = 0; q < parsers.length; q++) lock(parsers[q][0], parsers[q][1]);
  var frames = "iframe,frame,frameset,object,embed,portal,fencedframe";
  var addedNodes = describe(MutationRecord.prototype, "addedNodes").get;
  var listLength = describe(NodeList.prototype, "length").get;
  var listItem = NodeList.prototype.item;
  var nodeType = describe(Node.prototype, "nodeType").get;
  var matches = Element.prototype.matches, remove = Element.prototype.remove, select = Element.prototype.querySelectorAll;
  var selectInRoot = DocumentFragment.prototype.querySelectorAll, observe = MutationObserver.prototype.observe;
  var attach = Element.prototype.attachShadow, shadowOf = describe(Element.prototype, "shadowRoot").get, assign = Object.assign;
  var each = function (list, visit) {
    var count = apply(listLength, list, []);
    for (var n = 0; n < count; n++) visit(apply(listItem, list, [n]));
  };
  var removeNode = function (node) { apply(remove, node, []); };
  var watch = { childList: true, subtree: true };
  var observer, follow;
  var enter = function (element) {
    var root = apply(shadowOf, element, []);
    if (root) follow(root);
  };
  follow = function (root) {
    apply(observe, observer, [root, watch]);
    each(apply(selectInRoot, root, [frames]), removeNode);
    each(apply(selectInRoot, root, ["*"]), enter);
  };
  var drop = function (node) {
    if (apply(nodeType, node, []) !== 1) return;
    if (apply(matches, node, [frames])) { removeNode(node); return; }
    each(apply(select, node, [frames]), removeNode);
    enter(node);
    each(apply(select, node, ["*"]), enter);
  };
  observer = new MutationObserver(function (records) {
    for (var r = 0; r < records.length; r++) each(apply(addedNodes, records[r], []), drop);
  });
  apply(observe, observer, [document, watch]);
  if (attach) {
    define(Element.prototype, "attachShadow", {
      value: function attachShadow(init) {
        var options = assign({}, init);
        options.mode = "open";
        var root = apply(attach, this, [options]);
        follow(root);
        return root;
      },
      writable: false, enumerable: false, configurable: false
    });
  }
})();`;

const isTagSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\f" || c === "\r";

/**
 * The raw value of the first `shadowrootmode` attribute of the `<template`
 * start tag whose name ends at `from`, read the way the HTML tokenizer reads
 * a start tag ("" for an attribute without a value); null when the tag has
 * none before it ends or the text ends; undefined when the shared `budget`
 * ran out first.
 */
const firstShadowRootMode = (html: string, from: number, budget: { steps: number }): string | null | undefined => {
    const n = html.length;
    let i = from;
    for (;;) {
        const before = i;
        // Before attribute name (also after a quoted value, and after a stray `/`).
        while (i < n && isTagSpace(html[i])) i++;
        if (i >= n || html[i] === ">") return null;
        if (html[i] === "/") {
            i++;
            continue;
        }
        // Attribute name: its first character is part of it even when it is `=`.
        const nameStart = i++;
        while (i < n && !isTagSpace(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
        const name = html.slice(nameStart, i);
        while (i < n && isTagSpace(html[i])) i++;
        let value = "";
        if (html[i] === "=") {
            i++;
            while (i < n && isTagSpace(html[i])) i++;
            const quote = html[i];
            if (quote === '"' || quote === "'") {
                const close = html.indexOf(quote, i + 1);
                if (close < 0) return null;
                value = html.slice(i + 1, close);
                i = close + 1;
            } else {
                const start = i;
                while (i < n && !isTagSpace(html[i]) && html[i] !== ">") i++;
                value = html.slice(start, i);
            }
        }
        // Names compare in ASCII case only, as the tokenizer lowercases them; a later duplicate is dropped.
        if (/^shadowrootmode$/i.test(name)) return value;
        budget.steps -= i - before;
        if (budget.steps < 0) return undefined;
    }
};

/** What is put in front of a closed declarative root's attributes. The first of two same-named attributes wins. */
const OPEN_SHADOW_ROOT = " shadowrootmode=open ";

/**
 * Makes every declarative shadow root in a page's own markup open, so the
 * guard can follow it (`host.shadowRoot`); a closed one is unreachable from
 * script. The parser attaches a declarative root without calling
 * `attachShadow`, and no policy switches declarative shadow DOM off, so this
 * is done in the text, before the frame parses it.
 *
 * Each `<template` start tag is read on its own, as the tokenizer reads a
 * start tag (quoted values may hold `>`), up to its first `shadowrootmode`
 * attribute. When that value is `closed`, or holds a character reference
 * that could spell it, ` shadowrootmode=open ` is put straight after the tag
 * name: the first of two same-named attributes wins, so the root is open and
 * keeps its content, styles and other options. Nothing is replaced and the
 * insertion has no quote, so it cannot end a string or change a script's
 * syntax; an open root, a template without the attribute, and every
 * `shadowroot`/`shadowrootmode` word that is not such an attribute are left
 * as written.
 *
 * Every `<template` in the text is read, inside a script, a comment or an
 * attribute value too: a pass that skipped those would have to know where the
 * browser thinks they end, and could be made to skip a tag the browser parses
 * (`<!-->` ends a comment at once). The cost is that a literal closed template
 * tag in a script string gains the same words. A page made so that every read
 * runs to its end cannot make the pass quadratic: after a budget linear in
 * the page, a tag is treated as closed whenever the word comes after it.
 *
 * The old attribute name `shadowroot` is not handled: Chromium 159 does not
 * make a root from it (measured). Applied only when a preview frame is built
 * -- a shared snapshot keeps the page as it was.
 */
export const openDeclarativeShadowRoots = (html: string) => {
    const mentions = /shadowrootmode/gi;
    let lastMention = -1;
    for (let found = mentions.exec(html); found; found = mentions.exec(html)) lastMention = found.index;
    if (lastMention < 0) return html;
    const budget = { steps: 4 * html.length + 65_536 };
    const starts = /<template(?=[\t\n\f\r />])/gi;
    let out = "";
    let copied = 0;
    for (let start = starts.exec(html); start; start = starts.exec(html)) {
        const from = start.index + "<template".length;
        const mode = firstShadowRootMode(html, from, budget);
        const closed = mode === undefined ? from < lastMention : mode !== null && (/^closed$/i.test(mode) || mode.includes("&"));
        if (!closed) continue;
        out += html.slice(copied, from) + OPEN_SHADOW_ROOT;
        copied = from;
    }
    return out + html.slice(copied);
};

/** A CSP nonce as an embedding document can carry it (base64 characters). */
export const isEmbedderNonce = (nonce: string | null | undefined): nonce is string =>
    typeof nonce === "string" && /^[A-Za-z0-9+/_=-]{8,200}$/.test(nonce);

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
 *
 * Right after our policy, ahead of the page, comes HTML_PREVIEW_GUARD_SCRIPT.
 * In the chat the frame inherits the app's nonce policy, so the guard carries
 * the embedding document's nonce (`options.nonce`) or it would not run; the
 * public share page has no nonce and needs none.
 */
export function buildHtmlPreviewSrcdoc(
    html: string,
    assetOrigin?: string | null,
    options: { nonce?: string | null } = {}
): string {
    const page = openDeclarativeShadowRoots(html.replace(LEADING_DOCTYPE, ""));
    const nonce = isEmbedderNonce(options.nonce) ? ` nonce="${options.nonce}"` : "";
    // The second meta switches off the browser's own DNS prefetching for the
    // frame. A CSP does not cover resource hints (`<link rel="preconnect">`
    // and the like); they are a known residual risk. The page is NOT parsed
    // here to strip them: this parent document never parses or rewrites the
    // model's HTML, with two exceptions -- withEmbedderNonce, and
    // openDeclarativeShadowRoots above, which only puts
    // ` shadowrootmode=open ` in front of a closed declarative root's
    // attributes, because no other way reaches a closed root.
    const inner =
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${htmlPreviewCsp(assetOrigin)}">` +
        `<meta http-equiv="x-dns-prefetch-control" content="off">` +
        `<script${nonce}>${HTML_PREVIEW_GUARD_SCRIPT}</script>${page}`;
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
    if (!isEmbedderNonce(nonce)) return html;
    const document = parse(html);
    for (const element of Array.from(document.querySelectorAll('script, style, link[rel~="stylesheet" i]'))) {
        element.setAttribute("nonce", nonce);
    }
    return document.documentElement.outerHTML;
}
