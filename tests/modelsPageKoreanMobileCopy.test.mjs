import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../components/marketing/ModelsPageContent.tsx", import.meta.url),
  "utf8",
);

test("Korean models page mobile intro uses the same product names as the Korean menu", () => {
  const koBlock = source.slice(source.indexOf("  ko: {"));
  const match = koBlock.match(/mobileDescription: "([^"]+)"/);
  assert.ok(match, "ko mobileDescription is present");
  assert.match(match[1], /채팅과 리뷰/);
  assert.doesNotMatch(match[1], /\bChat\b|\bReview\b/);
});
