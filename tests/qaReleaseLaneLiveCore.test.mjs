import assert from "node:assert/strict";
import test from "node:test";

import { qaReleaseLaneLiveVerdicts } from "../lib/qaReleaseLaneLiveCore.ts";

const verdict = (number, status, reasons = []) => ({ number, title: `Pull ${number}`, headRefName: `b${number}`, status, reasons, files: [], failedChecks: [] });
const list = [verdict(1, "waiting", ["checks_pending"]), verdict(2, "waiting", ["checks_pending"]), verdict(3, "queued"), verdict(4, "human", ["schema_change"])];

test("a pull request no longer open leaves; finished CI stops saying it runs", () => {
  const live = qaReleaseLaneLiveVerdicts(list, { open: [1, 2, 4], ciRunning: [2] });
  assert.deepEqual(live.map((v) => v.number), [1, 2, 4]);
  assert.deepEqual(live[0].reasons, ["checks_done"]);
  assert.equal(live[0].status, "waiting", "the lane decides the result on its next round");
  assert.deepEqual(live[1].reasons, ["checks_pending"]);
  assert.deepEqual(live[2], list[3]);
});

test("unread GitHub leaves the lane's record as it is", () => {
  assert.deepEqual(qaReleaseLaneLiveVerdicts(list, null), list);
});
