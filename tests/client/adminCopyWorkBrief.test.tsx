import assert from "node:assert/strict";
import test from "node:test";

import { copyWorkBrief } from "@/components/admin/AdminCopyWorkBriefButton";

// Admin's "Copy brief" (Scout suggestions, routing recommendations): the brief
// goes to the clipboard and nowhere else, and a clipboard that refuses or is
// missing is reported as a failure rather than a silent success.

test("a working clipboard receives the brief as written", async () => {
  const written: string[] = [];
  const outcome = await copyWorkBrief({ writeText: async (value: string) => void written.push(value) }, "# brief\nline");
  assert.equal(outcome, "copied");
  assert.deepEqual(written, ["# brief\nline"]);
});

test("a refused or missing clipboard is a failure", async () => {
  assert.equal(await copyWorkBrief({ writeText: async () => { throw new DOMException("denied", "NotAllowedError"); } }, "x"), "failed");
  assert.equal(await copyWorkBrief(undefined, "x"), "failed");
});
