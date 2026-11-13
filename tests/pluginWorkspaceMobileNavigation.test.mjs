import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../components/plugins/pluginWorkspace.module.css", import.meta.url), "utf8");
const mobile = css.match(/@media\(max-width:767px\) \{ \.shell \{[^\n]*/)?.[0] ?? "";

test("mobile plugin navigation sits in its own bottom row instead of floating over the page", () => {
  assert.ok(mobile, "mobile plugin layout block exists");
  const nav = mobile.match(/\.shell :global\(\.review-navigation\) \{([^}]*)\}/)?.[1] ?? "";
  assert.match(nav, /position:static/);
  assert.match(nav, /order:1/);
  assert.doesNotMatch(nav, /position:fixed/);
  assert.match(mobile, /\.shell \{[^}]*display:flex;[^}]*flex-direction:column;[^}]*height:100dvh/);
  assert.match(mobile, /\.main \{[^}]*min-height:0;[^}]*overflow-y:auto/);
});
