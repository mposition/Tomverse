import assert from "node:assert/strict";
import test from "node:test";
import {
  cspSourcePosition,
  isTrustedCspDocumentUri,
  sanitizeCspReportedUrl,
} from "../lib/cspReportCore.ts";

test("CSP reports accept Tomverse documents and remove query data", () => {
  const value = "https://tomverse.app/admin/models?token=private#section";
  assert.equal(isTrustedCspDocumentUri(value), true);
  assert.equal(sanitizeCspReportedUrl(value), "https://tomverse.app/admin/models");
});

test("CSP reports from Outlook Safe Links are not promoted to incidents", () => {
  const value =
    "https://na01.safelinks.protection.outlook.com/?url=https%3A%2F%2Ftomverse.app%2Fadmin%2Fmodels&data=tracking";
  assert.equal(isTrustedCspDocumentUri(value), false);
  assert.equal(
    sanitizeCspReportedUrl(value),
    "https://na01.safelinks.protection.outlook.com/"
  );
});

test("CSP report origin validation rejects deceptive and non-web URLs", () => {
  assert.equal(
    isTrustedCspDocumentUri("https://tomverse.app@evil.example/admin"),
    false
  );
  assert.equal(isTrustedCspDocumentUri("data:text/html,tomverse.app"), false);
  assert.equal(sanitizeCspReportedUrl("eval"), "eval");
});

/**
 * `script-src blocked eval` on /chat ran for weeks as an unactionable
 * warning: the report named the page, which every such report does, and
 * nothing about who called eval. The source file and position are what
 * separate our own bundle from an allowed third-party tag from a browser
 * extension.
 */
test("an extension source is reduced to its scheme, never its identity", () => {
  assert.equal(
    sanitizeCspReportedUrl(
      "chrome-extension://mkfokfffehpeedafpekjeddnmnjhmcmk/injected.js"
    ),
    "chrome-extension:"
  );
  assert.equal(
    sanitizeCspReportedUrl("moz-extension://8f2a/content.js"),
    "moz-extension:"
  );
});

test("a first-party or third-party script source keeps origin and path", () => {
  assert.equal(
    sanitizeCspReportedUrl("https://tomverse.app/_next/static/chunks/main.js?v=2"),
    "https://tomverse.app/_next/static/chunks/main.js"
  );
  assert.equal(
    sanitizeCspReportedUrl("https://www.googletagmanager.com/gtm.js?id=GTM-XYZ"),
    "https://www.googletagmanager.com/gtm.js"
  );
});

test("source position reads either report spelling and needs a real line", () => {
  assert.equal(cspSourcePosition({ "line-number": 12, "column-number": 40 }), "12:40");
  assert.equal(cspSourcePosition({ lineNumber: 12, columnNumber: 40 }), "12:40");
  // A line with no column is still worth having.
  assert.equal(cspSourcePosition({ lineNumber: 12 }), "12");
  // A column with no line is not a position.
  assert.equal(cspSourcePosition({ columnNumber: 40 }), "");
  for (const report of [
    {},
    { lineNumber: "12" },
    { lineNumber: -1 },
    { lineNumber: 1.5 },
    { lineNumber: Number.NaN },
  ]) {
    assert.equal(cspSourcePosition(report), "");
  }
});
