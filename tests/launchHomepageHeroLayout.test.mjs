import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync("components/marketing/LaunchHomepage.module.css", "utf8");

test("the GPT stamp's entrance never slides left into the hero paragraph", () => {
  const keyframes = css.match(/@keyframes kf_13_269_translate_0 \{[^\n]*\}/);
  assert.ok(keyframes, "the GPT stamp entrance keyframes are missing");
  for (const [, x] of keyframes[0].matchAll(/translate:\s*(-?\d+(?:\.\d+)?)px/g)) {
    // The hero grid gap is 32px at its narrowest desktop width; any further
    // left and the tilted card covers the end of the paragraph's first line.
    assert.ok(Number(x) > -24, `GPT stamp starts ${x}px left, over the hero paragraph`);
  }
});
