import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";

// The homepage V2 stylesheet is a global CSS file imported by LaunchHomepage, so
// its only isolation is the .tv-home scope. These checks keep it from leaking
// into other pages and hold it to docs/ui-contracts/typography.md.
const css = readFileSync("components/marketing/home/home-v2.css", "utf8");
const root = postcss.parse(css);

test("every homepage V2 rule is scoped under .tv-home", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-home(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
});

test("homepage V2 keyframes are prefixed so they cannot collide with another page's", () => {
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvh-/, at.params));
});

test("homepage V2 text stays at or above the 11px floor and uses the locale font variables", () => {
  const small = [];
  root.walkDecls(/^font(-size)?$/, (decl) => {
    for (const [, value, unit] of decl.value.matchAll(/(?:^|[\s/(,])(\d*\.?\d+)(rem|px)\b/g)) {
      const px = Number(value) * (unit === "rem" ? 16 : 1);
      // Line heights after a slash are unitless or larger than any font size here.
      if (px > 0 && px < 11) small.push(`${decl.parent.selector} { ${decl.prop}: ${decl.value} }`);
    }
  });
  assert.deepEqual(small, []);
  assert.match(css, /--font-display: var\(--font-ui\);/);
  assert.match(css, /--font-body: var\(--font-ui\);/);
  assert.match(css, /--font-mono: var\(--font-code\);/);
  assert.doesNotMatch(css, /font-family:\s*["']?Geist/);
});
