import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Korean marketing nav names the Review product "리뷰", so the support
 * page body has to use the same name instead of the English one.
 */

const ROOT = resolve(import.meta.dirname, "..");
const supportSource = readFileSync(
  resolve(ROOT, "components/marketing/SupportPageContent.tsx"),
  "utf8"
);
const chromeSource = readFileSync(
  resolve(ROOT, "components/marketing/MarketingChrome.tsx"),
  "utf8"
);

const koBlock = () => {
  const start = supportSource.indexOf('"ko": {');
  const end = supportSource.indexOf('"zh": {', start);
  assert.ok(start >= 0 && end > start, "Korean support copy not found");
  return supportSource.slice(start, end);
};

test("Korean support copy names Review the way the nav does", () => {
  assert.match(chromeSource, /lang === "ko" \? "리뷰" : "Review"/);
  const ko = koBlock();
  assert.match(ko, /"appCta": "리뷰 열기"/);
  assert.match(ko, /"messageExample": "예: 리뷰에서 PDF를/);
  assert.doesNotMatch(ko, /"appCta": "Review/);
  assert.doesNotMatch(ko, /"messageExample": "[^"]*Review에서/);
});
