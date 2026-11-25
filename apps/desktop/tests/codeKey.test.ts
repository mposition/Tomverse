import assert from "node:assert/strict";
import test from "node:test";
import { readCopiedCodeKey } from "../src/host/code-key";

test("only a complete Tomverse API key is accepted from a clipboard action", () => {
  const key = "tvk_abcdefgh_" + "A".repeat(43);
  assert.equal(readCopiedCodeKey("  " + key + "\r\n"), key);
  for (const value of ["tvk_abcdefgh", "Bearer " + key, key + "\nOther contents", "An unrelated clipboard item"]) {
    assert.equal(readCopiedCodeKey(value), null);
  }
});
