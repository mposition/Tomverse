import assert from "node:assert/strict";
import test from "node:test";

import {
  REACT_PREVIEW_BOOTSTRAP,
  REACT_PREVIEW_SCRIPTS,
  artifactPreviewKind,
  buildCodePreviewDocument,
  buildReactPreviewDocument,
  buildSvgPreviewDocument,
  codeLanguageFromClassName,
  codePreviewKindForLanguage,
} from "../lib/chatArtifactPreview.ts";
import {
  HTML_PREVIEW_CDN_HOSTS,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_MAX_BYTES,
  buildHtmlPreviewSrcdoc,
} from "../lib/htmlArtifactPreview.ts";

/**
 * What an answer's code block may become, and the one extra document (React)
 * this adds to the generated-HTML preview. The isolation itself stays pinned by
 * tests/htmlArtifactPreview.test.mjs; the tests below make sure these new
 * documents go through it unchanged and ask nothing more of it.
 */

const labels = {
  errorTitle: "This preview couldn't run",
  loadFailed: "Could not load",
  noComponent: "No screen",
  missingPackage: 'The package "{name}" isn\'t available',
};

test("only html, svg and jsx/tsx fences are previewable, whatever their case", () => {
  assert.equal(codePreviewKindForLanguage("html"), "html");
  assert.equal(codePreviewKindForLanguage("HTM"), "html");
  assert.equal(codePreviewKindForLanguage("svg"), "svg");
  assert.equal(codePreviewKindForLanguage("jsx"), "react");
  assert.equal(codePreviewKindForLanguage("TSX"), "react");
  for (const other of ["js", "ts", "javascript", "css", "python", "bash", "json", "xml", "", null, undefined, "constructor", "__proto__", "toString"]) {
    assert.equal(codePreviewKindForLanguage(other), null, String(other));
  }
});

test("the fence language is read from the class rehype-highlight leaves on <code>", () => {
  assert.equal(codeLanguageFromClassName("hljs language-html"), "html");
  assert.equal(codeLanguageFromClassName("language-TSX"), "tsx");
  assert.equal(codeLanguageFromClassName("language-c++ hljs"), "c++");
  assert.equal(codeLanguageFromClassName("hljs"), null);
  assert.equal(codeLanguageFromClassName(""), null);
  assert.equal(codeLanguageFromClassName(undefined), null);
  assert.equal(codeLanguageFromClassName("xlanguage-html"), null);
});

test("a generated file previews as HTML always, and as React only with the switch on and only when ready", () => {
  const ready = (format) => ({ format, status: "ready" });
  assert.equal(artifactPreviewKind(ready("html"), { react: false }), "html");
  assert.equal(artifactPreviewKind(ready("HTM"), { react: false }), "html");
  assert.equal(artifactPreviewKind(ready("jsx"), { react: false }), null);
  assert.equal(artifactPreviewKind(ready("tsx"), { react: false }), null);
  assert.equal(artifactPreviewKind(ready("jsx"), { react: true }), "react");
  assert.equal(artifactPreviewKind(ready("tsx"), { react: true }), "react");
  for (const format of ["js", "ts", "svg", "css", "md", "xlsx"]) {
    assert.equal(artifactPreviewKind(ready(format), { react: true }), null, format);
  }
  assert.equal(artifactPreviewKind({ format: "html", status: "failed" }, { react: true }), null);
  assert.equal(artifactPreviewKind({ format: "tsx", status: "blocked" }, { react: true }), null);
});

test("React libraries come only from the preview's allowed CDNs, at an exact version, with an integrity hash", () => {
  assert.equal(REACT_PREVIEW_SCRIPTS.length, 3);
  for (const { src, integrity } of REACT_PREVIEW_SCRIPTS) {
    assert.ok(HTML_PREVIEW_CDN_HOSTS.some((host) => src.startsWith(`${host}/`)), `${src} is on an allowed CDN`);
    assert.match(src, /\/\d+\.\d+\.\d+\//, `${src} pins an exact version`);
    assert.match(integrity, /^sha384-[A-Za-z0-9+/]{64}$/, `${src} has a sha384 integrity hash`);
  }
  // The allowed list itself is not widened by this feature.
  assert.deepEqual([...HTML_PREVIEW_CDN_HOSTS], ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"]);
});

test("the React document names every script it loads, and nothing else loads from anywhere", () => {
  const html = buildReactPreviewDocument("export default () => <p>hi</p>;", { typescript: false, labels });
  const sources = [...html.matchAll(/<script src="([^"]+)" integrity="([^"]+)" crossorigin="anonymous">/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(sources, REACT_PREVIEW_SCRIPTS.map((s) => [s.src, s.integrity]));
  // No other external reference: every URL in the document is one of the three pinned files.
  const urls = html.match(/https?:\/\/[^"'\s<>)]+/g) ?? [];
  assert.deepEqual(urls.sort(), REACT_PREVIEW_SCRIPTS.map((s) => s.src).sort());
  assert.doesNotMatch(html, /<(iframe|object|embed|form|base|link)\b/i);
});

test("the in-frame bootstrap needs no eval and no Function constructor, so the frame's policy stays without 'unsafe-eval'", () => {
  assert.doesNotMatch(REACT_PREVIEW_BOOTSTRAP, /\beval\s*\(/);
  assert.doesNotMatch(REACT_PREVIEW_BOOTSTRAP, /new\s+Function\b|\bFunction\s*\(/);
  assert.doesNotMatch(REACT_PREVIEW_BOOTSTRAP, /setTimeout\s*\(\s*["'`]/);
  assert.ok(!HTML_PREVIEW_CSP.includes("'unsafe-eval'"));
  // It cannot reach out: nothing in it fetches, opens, navigates or posts.
  assert.doesNotMatch(REACT_PREVIEW_BOOTSTRAP, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|postMessage|window\.open|location\s*[=.]|top\.|parent\.)/);
  // And it hands the embedding page's nonce to the one script it creates, which is what lets an enforced nonce policy admit it.
  assert.match(REACT_PREVIEW_BOOTSTRAP, /document\.currentScript[\s\S]*\.nonce/);
  assert.match(REACT_PREVIEW_BOOTSTRAP, /script\.nonce\s*=\s*nonce/);
  assert.ok(!REACT_PREVIEW_BOOTSTRAP.includes("\\"), "no backslashes: the string is the same in source and at runtime");
});

test("a React answer is held as text in the document, so nothing in it can close the element or add one", () => {
  const hostile = '</textarea><script>alert(1)</script><img src=x onerror="alert(2)">&amp; <b>';
  const html = buildReactPreviewDocument(hostile, { typescript: true, labels });
  assert.ok(!html.includes("</textarea><script>alert(1)"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&amp;amp; &lt;b&gt;"), "an ampersand in the code survives the round trip");
  // Exactly the four <script> tags of the preview: three libraries and the bootstrap.
  assert.equal((html.match(/<script\b/g) ?? []).length, 4);
  assert.match(html, /data-language="tsx"/);
  assert.match(buildReactPreviewDocument("x", { typescript: false, labels }), /data-language="jsx"/);
});

test("the sentences the page shows are escaped into attributes, not interpreted", () => {
  const html = buildReactPreviewDocument("x", {
    typescript: false,
    labels: { errorTitle: '"><script>alert(1)</script>', loadFailed: "a&b", noComponent: "<b>", missingPackage: "{name} \"x\"" },
  });
  assert.ok(!html.includes('"><script>alert(1)'));
  assert.ok(html.includes('data-error-title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
  assert.ok(html.includes('data-load-failed="a&amp;b"'));
  assert.ok(html.includes('data-no-component="&lt;b&gt;"'));
  assert.ok(html.includes("data-missing-package=\"{name} &quot;x&quot;\""));
});

test("every preview document goes through the same isolation: our policy first, sandbox allow-scripts and nothing more", () => {
  const unescape = (value) => value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const documents = {
    html: buildCodePreviewDocument("html", "<h1>x</h1>", { labels }),
    svg: buildCodePreviewDocument("svg", '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>', { labels }),
    react: buildCodePreviewDocument("react", "export default function App() { return <p>x</p>; }", { language: "tsx", labels }),
  };
  for (const [kind, built] of Object.entries(documents)) {
    assert.equal(built.ok, true, kind);
    const srcdoc = buildHtmlPreviewSrcdoc(built.html);
    const match = /^<!doctype html><meta http-equiv="Content-Security-Policy" content="([^"]*)"><body[^>]*><iframe ([^>]*?) srcdoc="([^"]*)"><\/iframe>$/.exec(srcdoc);
    assert.ok(match, `${kind}: one outer document holding one frame`);
    assert.equal(match[1], "frame-src 'none'", kind);
    assert.match(match[2], /sandbox="allow-scripts"/, kind);
    assert.doesNotMatch(match[2], /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads/, kind);
    const inner = unescape(match[3]);
    assert.ok(inner.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`), `${kind}: our policy is the first element`);
    assert.ok(HTML_PREVIEW_CSP.includes("connect-src 'none'"));
  }
  assert.equal(documents.html.html, "<h1>x</h1>", "an HTML block is the page, as written");
});

test("an SVG block is centred on a page and its XML prologue is dropped, the drawing itself untouched", () => {
  const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const page = buildSvgPreviewDocument(`<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<!-- c -->\n${svg}`);
  assert.ok(page.includes(`<body>${svg}</body>`));
  assert.doesNotMatch(page, /<\?xml|DOCTYPE svg/);
});

test("empty and oversized code is refused with a reason, not previewed", () => {
  assert.deepEqual(buildCodePreviewDocument("html", "  \n ", { labels }), { ok: false, reason: "empty" });
  const big = "x".repeat(HTML_PREVIEW_MAX_BYTES + 1);
  for (const kind of ["html", "svg", "react"]) {
    assert.deepEqual(buildCodePreviewDocument(kind, big, { labels }), { ok: false, reason: "too_large" }, kind);
  }
  assert.equal(buildCodePreviewDocument("html", "x".repeat(HTML_PREVIEW_MAX_BYTES), { labels }).ok, true);
  // The limit is in bytes, as for a file: multi-byte text counts for what it weighs.
  assert.equal(buildCodePreviewDocument("html", "가".repeat(Math.floor(HTML_PREVIEW_MAX_BYTES / 3) + 1), { labels }).ok, false);
});
