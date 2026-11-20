import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";
import { reviewDemoVideo } from "../components/marketing/v2/reviewDemoVideo.ts";

test("every site language has its own answer comparison recording and poster", () => {
  const sources = new Set();
  for (const lang of SUPPORTED_LANGUAGES) {
    const { src, poster } = reviewDemoVideo(lang);
    for (const path of [src, poster]) {
      const file = join("public", path);
      assert.ok(existsSync(file), `${lang}: ${file} is missing`);
      assert.ok(statSync(file).size > 10_000, `${lang}: ${file} looks empty`);
    }
    sources.add(src);
  }
  assert.equal(sources.size, SUPPORTED_LANGUAGES.length, "each language points at its own file");
});
