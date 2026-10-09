import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AMUX_EXECUTION_LANES, AMUX_EXECUTION_VISIBLE_LANES,
  amuxExecutionLaneWhere, parseAmuxExecutionLane,
  parseAmuxExecutionPage, amuxVisibleInspectionText,
  amuxVisibleUntrustedText,
} from "../lib/amux/adminExecutionViewCore.ts";

test("six board lanes and archive are separate projections", () => {
  assert.equal(AMUX_EXECUTION_VISIBLE_LANES.length, 6);
  assert.equal(AMUX_EXECUTION_LANES.length, 7);
  assert.equal(parseAmuxExecutionLane("attention"), "attention");
  assert.equal(parseAmuxExecutionLane("unknown"), null);
  assert.equal(parseAmuxExecutionPage(null), 0);
  assert.equal(parseAmuxExecutionPage("0"), 0);
  assert.equal(parseAmuxExecutionPage("10001"), null);
  assert.equal(parseAmuxExecutionPage("01"), null);
  assert.equal(parseAmuxExecutionPage("-1"), null);
  assert.deepEqual(amuxExecutionLaneWhere("amux_backlog").AND[2],
    { status: "todo", v22AssignmentId: null });
  assert.deepEqual(amuxExecutionLaneWhere("todo").AND[2],
    { status: "todo", v22AssignmentId: { not: null } });
  assert.equal(JSON.stringify(amuxExecutionLaneWhere("attention")).includes("humanEscalations"), true);
  assert.equal(JSON.stringify(amuxExecutionLaneWhere("in_review")).includes('"status":"review"'), true);
  assert.deepEqual(amuxExecutionLaneWhere("archive").OR[1].AND[2],
    { status: { in: ["done", "cancelled"] } });
});

test("worker text renders controls visibly without conflating literal escapes", () => {
  assert.notEqual(amuxVisibleUntrustedText("x\u202ey"),
    amuxVisibleUntrustedText("x\\u202ey"));
  assert.match(amuxVisibleUntrustedText("x\u202ey"), /\\u202e/);
  assert.match(amuxVisibleUntrustedText("x\u0001y"), /\\u0001/);
  assert.equal(amuxVisibleInspectionText("plain\n한국어"), "plain\n한국어");
  assert.equal(amuxVisibleInspectionText("x\u202ey"), "x\\u{202E}y");
  assert.equal(amuxVisibleInspectionText("x\\u{202E}y"), "x\\\\u{202E}y");
  assert.equal(amuxVisibleInspectionText("x\ud800y"), "x\\u{D800}y");
  assert.equal(amuxVisibleInspectionText("x\u{E0001}2"), "x\\u{E0001}2");
  assert.equal(amuxVisibleUntrustedText("x\u{E0001}2"),
    '"x\\udb40\\udc012"');
});

test("execution UI reads the same DB through bounded owner-only read routes", async () => {
  const route = await readFile(new URL("../app/api/admin/amux/execution-view/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../lib/amux/adminExecutionRead.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../components/admin/AmuxExecutionWorkspace.tsx", import.meta.url), "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /private, no-store, max-age=0/);
  assert.match(service, /take: AMUX_EXECUTION_PAGE_SIZE/g);
  assert.match(service, /loadAmuxContentUnitKeys/);
  assert.match(service, /verifyAmuxContentDigest/);
  assert.match(service, /readAmuxV22TaskResultForOwner/);
  assert.match(ui, /aria-expanded=/);
  assert.match(ui, /m\.loadMore\(/);
  assert.match(ui, /selected\.reviews/);
  assert.match(ui, /selected\.result\.text/);
  assert.match(ui, /selected\.result\.sha256/);
  assert.match(ui, /amuxVisibleInspectionText\(selectedBody\.problem\)/);
  assert.match(ui, /amuxVisibleInspectionText\(selected\.brief\)/);
  assert.match(ui, /currentRevision/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(ui, /method: "(POST|PUT|PATCH|DELETE)"/);
});
