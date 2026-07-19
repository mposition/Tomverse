import assert from "node:assert/strict";
import test from "node:test";
import {
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
