import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const service = await readFile(
  new URL("../lib/amux/recommendationPoolService.ts", import.meta.url),
  "utf8",
);
const panel = await readFile(
  new URL("../components/admin/AmuxBoardRecommendationPanel.tsx", import.meta.url),
  "utf8",
);

const slice = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} .. ${end}`);
  return source.slice(from, to);
};

test("the recommendation view lists included and excluded rows without titles or source keys", () => {
  const included = slice(service, "const includedView", "const excludedView");
  const excluded = slice(service, "const excludedView", "const viewOf");
  assert.match(included, /sourceDigest: row\.sourceDigest/);
  assert.match(included, /expectedRevision: row\.expectedRevision/);
  assert.match(excluded, /exclusionCode: row\.exclusionCode/);
  for (const body of [included, excluded]) {
    assert.doesNotMatch(body, /title|sourceKey|executionBrief\b|description/);
  }
  const view = slice(service, "const viewOf", "const writesPermitted");
  assert.match(view, /included: includedView\(selection\.rows\)/);
  assert.match(view, /excluded: excludedView\(selection\.rows\)/);
});

test("prepare returns the snapshot's own included rows so an approve item can be built", () => {
  const commit = slice(service, "export async function commitRecommendationSnapshot", "export async function prepareRecommendation");
  assert.match(commit, /included: includedView\(selection\.rows\)/);
});

test("the panel renders both row lists and the snapshot id", () => {
  assert.match(panel, /data-testid="amux-recommendation-included"/);
  assert.match(panel, /data-testid="amux-recommendation-excluded"/);
  assert.match(panel, /messages\.snapshot\(result\.snapshotId\)/);
  assert.match(panel, /<th scope="col"/);
});
