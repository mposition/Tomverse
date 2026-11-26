import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsSubresource, classifyDocsNavigation, classifyLinkNavigation, DOC_PATHS, DOC_SECTIONS, docPathAllowed, docSectionFor, docsUrl,
  isCliGuideUrl, linkViewUrl, publicHostname, webViewCommand,
} from "../src/web-view-contract";

const origin = "https://tomverse.app";
const guideUrls = [
  "https://developers.openai.com/codex/auth",
  "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/getting-started.md",
  "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/",
];
const context = { origin, guideUrls };

test("Every documentation section maps to an allowed public Tomverse path", () => {
  for (const section of DOC_SECTIONS) {
    assert.ok(docPathAllowed(DOC_PATHS[section]), section);
    assert.equal(docSectionFor(DOC_PATHS[section]), section);
    assert.equal(classifyDocsNavigation(docsUrl(origin, section, "ko"), context), "docs", section);
  }
  assert.equal(docsUrl(origin, "pricing", "zh-Hant"), "https://tomverse.app/pricing?lang=zh-Hant");
});

test("Documentation paths accept a locale prefix and subpages but never the signed-in web app", () => {
  assert.ok(docPathAllowed("/ko/pricing"));
  assert.ok(docPathAllowed("/zh-Hant/support/help-centre"));
  assert.ok(docPathAllowed("/support/help-centre/guides/some-guide"));
  assert.ok(docPathAllowed("/developers/cli/"));
  assert.equal(docSectionFor("/ko/developers/cli"), "cli");
  assert.equal(docSectionFor("/developers/other"), "developers");
  for (const path of ["/chat", "/review", "/login", "/settings/api", "/admin", "/api/models/catalog", "/ko/chat", "/pricing-private", "/guides", "/"]) {
    assert.equal(docPathAllowed(path), false, path);
  }
});

test("The documentation view keeps Tomverse and provider guides, hands other public https links to the link view, and blocks the rest", () => {
  assert.equal(classifyDocsNavigation("https://tomverse.app/privacy", context), "docs");
  assert.equal(classifyDocsNavigation("https://tomverse.app/chat", context), "blocked");
  assert.equal(classifyDocsNavigation("https://developers.openai.com/codex/other", context), "docs");
  assert.equal(classifyDocsNavigation("https://github.com/MoonshotAI/kimi-code/issues", context), "docs");
  assert.equal(classifyDocsNavigation("https://github.com/someone/else", context), "link");
  assert.equal(classifyDocsNavigation("https://example.com/page", context), "link");
  for (const url of ["http://tomverse.app/privacy", "file:///C:/secret.txt", "javascript:alert(1)", "mailto:a@b.co", "https://user:pw@example.com/",
    "https://127.0.0.1/", "https://localhost/", "not a url", "https://tomverse.app.evil.net/privacy"]) {
    assert.notEqual(classifyDocsNavigation(url, context), "docs", url);
  }
  assert.equal(classifyDocsNavigation("http://tomverse.app/privacy", context), "blocked");
  assert.equal(classifyDocsNavigation("https://127.0.0.1/", context), "blocked");
  assert.equal(classifyDocsNavigation("https://tomverse.app.evil.net/privacy", context), "link");
});

test("Provider guide hosts stay scoped and a shared host never opens its whole site", () => {
  assert.ok(isCliGuideUrl("https://developers.openai.com/anything", guideUrls));
  assert.ok(isCliGuideUrl("https://github.com/MoonshotAI/kimi-code", guideUrls));
  assert.equal(isCliGuideUrl("https://github.com/MoonshotAIEvil/x", guideUrls), false);
  assert.equal(isCliGuideUrl("https://github.com/other/repo", guideUrls), false);
  assert.ok(isCliGuideUrl("https://qwenlm.github.io/qwen-code-docs/zh/", guideUrls));
  assert.equal(isCliGuideUrl("https://qwenlm.github.io/other/", guideUrls), false);
  assert.equal(isCliGuideUrl("http://developers.openai.com/codex/auth", guideUrls), false);
  assert.equal(isCliGuideUrl("https://openai.com/", guideUrls), false);
});

test("The link view accepts only https URLs with a public-looking name", () => {
  for (const url of ["https://example.com/", "https://sub.example.co.uk/a?b=c#d", "https://xn--p8jtb.example.org/", "https://example.com:8443/x"]) {
    assert.ok(linkViewUrl(url), url);
    assert.equal(classifyLinkNavigation(url), "link");
  }
  for (const url of [
    "http://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "blob:https://example.com/id", "ftp://example.com/",
    "mailto:a@example.com", "tel:+123", "view-source:https://example.com", "https://user@example.com/", "https://user:pw@example.com/",
    "https://localhost/", "https://app.localhost/", "https://127.0.0.1/", "https://127.1/", "https://2130706433/", "https://0x7f.0.0.1/",
    "https://10.0.0.5/", "https://192.168.1.1/", "https://172.16.0.1/", "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/",
    "https://0.0.0.0/", "https://[::1]/", "https://[fd00::1]/", "https://[::ffff:127.0.0.1]/", "https://printer/", "https://nas.local/",
    "https://router.lan/", "https://db.internal/", "https://host.home.arpa/", "https://example.onion/", "", "example.com", "https://",
    "https://" + "a".repeat(2100) + ".com/",
  ]) {
    assert.equal(linkViewUrl(url), null, url);
    assert.equal(classifyLinkNavigation(url), "blocked", url);
  }
  assert.equal(publicHostname("EXAMPLE.com."), true);
  assert.equal(publicHostname("localhost"), false);
});

test("The subresource name rule admits only https/wss to public-looking names and inline data", () => {
  for (const url of ["https://cdn.example.com/a.js", "wss://socket.example.com/s", "data:image/png;base64,AAAA", "blob:https://example.com/x"]) {
    assert.ok(allowsSubresource(url), url);
  }
  for (const url of ["http://cdn.example.com/a.js", "https://127.0.0.1:3000/", "https://localhost/api", "https://192.168.0.2/", "ws://example.com/",
    "file:///C:/x", "ftp://example.com/", "chrome://gpu", "devtools://devtools/bundled/inspector.html", "https://u:p@example.com/", "nonsense"]) {
    assert.equal(allowsSubresource(url), false, url);
  }
});

test("Web view commands name a documentation section or a link and nothing else", () => {
  assert.ok(webViewCommand.safeParse({ type: "open-docs", section: "help" }).success);
  assert.ok(webViewCommand.safeParse({ type: "open-link", url: "https://example.com" }).success);
  assert.ok(webViewCommand.safeParse({ type: "layout", bounds: null }).success);
  assert.ok(webViewCommand.safeParse({ type: "layout", bounds: { x: 1, y: 2, width: 3, height: 4 } }).success);
  for (const type of ["back", "forward", "reload", "stop", "return-to-docs", "close", "sync"]) assert.ok(webViewCommand.safeParse({ type }).success, type);
  for (const value of [
    { type: "open-docs", section: "chat" }, { type: "open-docs", section: "help", url: "https://example.com" },
    { type: "open-docs", url: "https://tomverse.app/chat" }, { type: "open-link", url: "" }, { type: "open-link", url: "x".repeat(2049) },
    { type: "layout", bounds: { x: -1, y: 0, width: 1, height: 1 } }, { type: "navigate", url: "https://example.com" }, {}, null,
  ]) {
    assert.equal(webViewCommand.safeParse(value).success, false, JSON.stringify(value));
  }
});
