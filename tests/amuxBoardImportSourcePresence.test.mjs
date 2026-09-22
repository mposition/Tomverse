import assert from "node:assert/strict";
import test from "node:test";

import { BOARD_IMPORT_MAX_ITEMS } from "../lib/amux/boardImportCore.ts";
import { loadBoardImportSourcePresence } from "../lib/amux/boardImportPreview.ts";

const stored = (count) =>
  Array.from({ length: count }, (_, index) => ({
    sourceSystem: "example_board",
    sourceKey: `K${String(index).padStart(4, "0")}`,
  }));

const db = (count) => ({
  amuxWorkItem: {
    findMany: async (args) => stored(count).slice(0, args.take),
  },
});

const oneItem = [{ sourceSystem: "example_board", sourceKey: "K0000" }];

test("the loader stops one past the item cap and a full page is not truncated", async () => {
  const cap = BOARD_IMPORT_MAX_ITEMS;
  const over = await loadBoardImportSourcePresence(db(cap + 1), oneItem);
  assert.equal(over.truncated, true);
  assert.equal(over.rows.length, cap);
  const exact = await loadBoardImportSourcePresence(db(cap), oneItem);
  assert.equal(exact.truncated, false);
  assert.equal(exact.rows.length, cap);
});
