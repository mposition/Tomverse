import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../components/marketing/LaunchHomepage.module.css", import.meta.url), "utf8");

test("rightmost model stamp entrance stays inside the clipped hero on desktop", () => {
  const keyframes = css.split("\n").find(line => line.startsWith("@keyframes kf_13_271_translate_0"));
  assert.ok(keyframes, "Gemini stamp keyframes exist");
  const offsets = [...keyframes.matchAll(/translate:\s*(-?\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
  assert.ok(offsets.length > 0);
  // Narrowest desktop right gutter is the 40px container padding (max-width: 1199px) minus the rotated card's overhang.
  for (const x of offsets) assert.ok(x <= 24, `Gemini stamp starts ${x}px right of its slot and is clipped`);
  assert.match(css, /\.hero \{[^}]*overflow: clip/);
});
