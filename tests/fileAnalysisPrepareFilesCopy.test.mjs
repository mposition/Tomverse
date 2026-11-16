import assert from "node:assert/strict";
import test from "node:test";
import { searchIntentPages } from "../components/marketing/searchIntentContent.ts";

test("file preparation guidance is split into model, file and verification bullets with a separate format caveat", () => {
  const section = searchIntentPages["ai-for-file-analysis"].en.sections.find(s => s.title === "Prepare files for better results");
  assert.ok(section);
  assert.match(section.body, /does not mean every model supports the original file natively/);
  assert.ok(section.formatGroups.length > 0);
  assert.deepEqual(section.bullets.map(b => b.split(":")[0]), ["Model choice", "File condition", "Verification"]);
  assert.match(section.bullets[0], /Choose an image-capable model for image attachments\./);
  for (const bullet of section.bullets) assert.ok(bullet.length < 160, bullet);
});
