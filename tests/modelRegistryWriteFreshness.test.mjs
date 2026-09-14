// A registry save must not silently revert a write it never saw.
//
// `PATCH /api/admin/models/{id}` writes the whole submitted body, so a save
// made from a panel opened ten minutes ago reverts everything written in
// between. The other writer is usually not a second operator -- in a
// one-person organisation there rarely is one -- it is catalogue
// reconciliation, which writes `maxOutputTokens` and `creditWeight` onto
// existing rows.
//
// AGENTS.md records what reverting one of those costs. A fossilised output cap
// is not a stale label, it is a ceiling on every answer the model gives:
// `claude-sonnet-5` was found serving with `maxOutputTokens` 4,096 against a
// profile of 128,000, and trace `2e4327a9` spent 4,095 tokens on reasoning and
// ended in `AI_EMPTY_RESPONSE.MAX_TOKENS`.
//
// All three boundaries below are places this guard could be wrong, and two of
// them fail open.

import assert from "node:assert/strict";
import test from "node:test";
import { modelRegistryWriteFreshness } from "../lib/modelRegistryAdmin.ts";

const at = (iso) => new Date(iso);

test("a row untouched since the read is fresh", () => {
  assert.deepEqual(
    modelRegistryWriteFreshness({
      readAt: "2026-09-14T10:00:00.000Z",
      updatedAt: at("2026-09-14T09:59:59.000Z"),
    }),
    { verdict: "fresh" }
  );
});

test("a row written after the read is stale, and says when", () => {
  const changedAt = at("2026-09-14T10:00:01.000Z");
  assert.deepEqual(
    modelRegistryWriteFreshness({
      readAt: "2026-09-14T10:00:00.000Z",
      updatedAt: changedAt,
    }),
    { verdict: "stale", changedAt }
  );
});

test("the same instant is fresh, not stale", () => {
  // `updatedAt` can equal the moment the list was read. Refusing that would
  // make the guard fire on a write nothing had touched, and the operator would
  // reload to find nothing different -- which teaches them to ignore it.
  assert.deepEqual(
    modelRegistryWriteFreshness({
      readAt: "2026-09-14T10:00:00.000Z",
      updatedAt: at("2026-09-14T10:00:00.000Z"),
    }),
    { verdict: "fresh" }
  );
});

test("a caller that never read the row cannot be stale", () => {
  // Absent rather than empty: a client that predates the parameter keeps
  // working, and a create has no row to have moved.
  for (const readAt of [null, undefined, ""]) {
    assert.deepEqual(
      modelRegistryWriteFreshness({
        readAt,
        updatedAt: at("2026-09-14T10:00:01.000Z"),
      }),
      { verdict: "fresh" },
      String(readAt)
    );
  }
});

test("a row that no longer exists is not reported as a conflict", () => {
  // Deletion is the update handler's own 404 to give; answering "someone
  // changed it" would send the operator to reload a row that has gone.
  assert.deepEqual(
    modelRegistryWriteFreshness({
      readAt: "2026-09-14T10:00:00.000Z",
      updatedAt: null,
    }),
    { verdict: "fresh" }
  );
});

test("an unparseable timestamp is refused rather than ignored", () => {
  // The failure mode a guard must not have. Treating a malformed value as
  // absent would let anything that mangles the parameter silently disable the
  // check, and nothing on either side would report it.
  for (const readAt of ["yesterday", "2026-13-45T99:99:99Z", "NaN"]) {
    assert.deepEqual(
      modelRegistryWriteFreshness({
        readAt,
        updatedAt: at("2026-09-14T10:00:01.000Z"),
      }),
      { verdict: "unreadable" },
      readAt
    );
  }
});
