import assert from "node:assert/strict";
import test from "node:test";

import { encodeAmuxAdminCardCursor,
  parseAmuxAdminCardCursor } from "../lib/amux/adminCardCursorCore.ts";

test("AMUX card cursor round-trips a stable timestamp and ID", () => {
  const cursor = { updatedAt: new Date("2026-10-03T00:00:00.123Z"), id: "card_123" };
  assert.deepEqual(parseAmuxAdminCardCursor(encodeAmuxAdminCardCursor(cursor)), cursor);
});

test("AMUX card cursor refuses malformed and overlong positions", () => {
  for (const raw of [undefined, "", "!", "a".repeat(513),
    Buffer.from(JSON.stringify(["not-a-date", "card_123"])).toString("base64url"),
    Buffer.from(JSON.stringify(["2026-10-03T00:00:00.123Z", "../card"])).toString("base64url")]) {
    assert.equal(parseAmuxAdminCardCursor(raw), null);
  }
  assert.throws(() => encodeAmuxAdminCardCursor({
    updatedAt: new Date("2026-10-03T00:00:00.123Z"), id: "../card",
  }), TypeError);
});
