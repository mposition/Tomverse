// The status chips on the AMUX section tabs.
//
// docs/ui-contracts/admin-console-ia.md rule 8: the console states only what
// it read. A chip saying "apply off" is a claim about a switch, so it must be
// read from that switch -- the same environment variable and shipped code
// latch the section's own route passes to the same permit function -- and
// never written as a string that goes on saying "off" after apply is turned on.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AMUX_TAB_SWITCHES,
  amuxSwitchedTabStatus,
  amuxSwitchedTabStatuses,
  amuxTabChips,
} from "../lib/adminAmuxTabStatus.ts";
import { AUTO_PROMOTION_APPLY_ENV, AUTO_PROMOTION_CODE_LATCH } from "../lib/amux/autoPromotionCore.ts";
import { BACKLOG_METADATA_APPLY_ENV, BACKLOG_METADATA_CODE_LATCH } from "../lib/amux/backlogMetadataCore.ts";
import { BOARD_IMPORT_APPLY_CODE_LATCH, BOARD_IMPORT_APPLY_ENV } from "../lib/amux/boardImportCore.ts";
import { BOARD_PROMOTION_APPLY_CODE_LATCH, BOARD_PROMOTION_APPLY_ENV } from "../lib/amux/boardPromotionCore.ts";
import {
  AMUX_RECONCILIATION_APPLY_CODE_LATCH,
  AMUX_RECONCILIATION_APPLY_ENV,
} from "../lib/amux/boardReconciliationCore.ts";
import { AMUX_INTAKE_APPLY_CODE_LATCH, AMUX_INTAKE_APPLY_ENV } from "../lib/amux/intakeCore.ts";
import { RECOMMENDATION_APPLY_ENV, RECOMMENDATION_CODE_LATCH } from "../lib/amux/recommendationPoolCore.ts";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

/**
 * For each gated tab: the variable, the shipped latch, and the file where the
 * section's own route reads that variable. The latch values are imported, not
 * written here -- whether a latch is armed is the policy's decision, and this
 * test only asks that the chip follow it.
 */
const SWITCHES = {
  intake: {
    env: AMUX_INTAKE_APPLY_ENV,
    envName: "AMUX_INTAKE_APPLY_ENV",
    latch: AMUX_INTAKE_APPLY_CODE_LATCH,
    reader: "app/api/admin/amux/intake/route.ts",
  },
  import: {
    env: BOARD_IMPORT_APPLY_ENV,
    envName: "BOARD_IMPORT_APPLY_ENV",
    latch: BOARD_IMPORT_APPLY_CODE_LATCH,
    latchName: "BOARD_IMPORT_APPLY_CODE_LATCH",
    reader: "lib/amux/boardImportService.ts",
  },
  reconciliation: {
    env: AMUX_RECONCILIATION_APPLY_ENV,
    envName: "AMUX_RECONCILIATION_APPLY_ENV",
    latch: AMUX_RECONCILIATION_APPLY_CODE_LATCH,
    reader: "app/api/admin/amux/reconciliation/route.ts",
  },
  metadata: {
    env: BACKLOG_METADATA_APPLY_ENV,
    envName: "BACKLOG_METADATA_APPLY_ENV",
    latch: BACKLOG_METADATA_CODE_LATCH,
    latchName: "BACKLOG_METADATA_CODE_LATCH",
    reader: "lib/amux/backlogMetadataService.ts",
  },
  recommendation: {
    env: RECOMMENDATION_APPLY_ENV,
    envName: "RECOMMENDATION_APPLY_ENV",
    latch: RECOMMENDATION_CODE_LATCH,
    latchName: "RECOMMENDATION_CODE_LATCH",
    reader: "lib/amux/recommendationPoolService.ts",
  },
  promotion: {
    env: BOARD_PROMOTION_APPLY_ENV,
    envName: "BOARD_PROMOTION_APPLY_ENV",
    latch: BOARD_PROMOTION_APPLY_CODE_LATCH,
    latchName: "BOARD_PROMOTION_APPLY_CODE_LATCH",
    reader: "lib/amux/boardPromotionService.ts",
  },
  "auto-promotion": {
    env: AUTO_PROMOTION_APPLY_ENV,
    envName: "AUTO_PROMOTION_APPLY_ENV",
    latch: AUTO_PROMOTION_CODE_LATCH,
    latchName: "AUTO_PROMOTION_CODE_LATCH",
    reader: "lib/amux/autoPromotionService.ts",
  },
};

test("every gated AMUX tab has a switch, and nothing else does", () => {
  assert.deepEqual(Object.keys(AMUX_TAB_SWITCHES).sort(), Object.keys(SWITCHES).sort());
});

test("each chip reads the variable its section's own route reads", () => {
  const status = read("lib/adminAmuxTabStatus.ts");
  for (const [tab, entry] of Object.entries(SWITCHES)) {
    const reader = read(entry.reader);
    assert.ok(
      reader.includes(`process.env[${entry.envName}]`),
      `${tab}: ${entry.reader} does not read ${entry.envName}`
    );
    assert.ok(status.includes(`env[${entry.envName}]`), `${tab}: the chip does not read ${entry.envName}`);
    if (entry.latchName) {
      assert.ok(reader.includes(entry.latchName), `${tab}: ${entry.reader} does not pass ${entry.latchName}`);
      assert.ok(status.includes(entry.latchName), `${tab}: the chip does not pass ${entry.latchName}`);
    }
  }
});

test("with the variable unset every chip says the writes are closed", () => {
  for (const tab of Object.keys(SWITCHES)) {
    assert.equal(
      amuxSwitchedTabStatus(tab, {}),
      tab === "auto-promotion" ? "behind_server_switch" : "preview_apply_off",
      tab
    );
  }
});

test("with the variable enabled a chip says open exactly when the shipped latch is armed", () => {
  for (const [tab, entry] of Object.entries(SWITCHES)) {
    const status = amuxSwitchedTabStatus(tab, { [entry.env]: "enabled" });
    const expected =
      tab === "auto-promotion"
        ? entry.latch
          ? "server_switch_on"
          : "behind_server_switch"
        : entry.latch
          ? "apply_on"
          : "preview_apply_off";
    assert.equal(status, expected, tab);
  }
});

test("only the exact value opens a switch", () => {
  for (const [tab, entry] of Object.entries(SWITCHES)) {
    for (const value of ["Enabled", "true", "1", " enabled", ""]) {
      assert.equal(
        amuxSwitchedTabStatus(tab, { [entry.env]: value }),
        tab === "auto-promotion" ? "behind_server_switch" : "preview_apply_off",
        `${tab}=${JSON.stringify(value)}`
      );
    }
  }
});

test("an open switch is drawn for attention and a closed one is not", () => {
  const labels = {
    preview_apply_off: "off",
    apply_on: "on",
    behind_server_switch: "behind",
    server_switch_on: "switch on",
    read_only: "read",
  };
  assert.deepEqual(
    amuxTabChips(
      { intake: "apply_on", import: "preview_apply_off", cards: "read_only", assignment: undefined },
      labels
    ),
    {
      intake: { label: "on", attention: true },
      import: { label: "off", attention: false },
      cards: { label: "read", attention: false },
    }
  );
  assert.deepEqual(amuxSwitchedTabStatuses(["auto-promotion"], {}), {
    "auto-promotion": "behind_server_switch",
  });
});

test("the pages ask the switches rather than writing the state", () => {
  for (const [segment, tabs] of [
    ["amux-backlog", ["import", "reconciliation", "metadata"]],
    ["amux-promotion", ["recommendation", "promotion", "auto-promotion"]],
  ]) {
    const page = read(`app/(site)/(application)/admin/${segment}/page.tsx`);
    assert.ok(
      page.includes(`amuxSwitchedTabStatuses([${tabs.map((tab) => `"${tab}"`).join(", ")}])`),
      `${segment} does not read every section's switch`
    );
    assert.doesNotMatch(page, /apply off|apply_off"|server switch/i, `${segment} writes a state`);
  }
  const execution = read("app/(site)/(application)/admin/amux-execution/page.tsx");
  // Assignment is read only exactly when the escalation routes would refuse
  // this viewer's decisions.
  assert.match(
    execution,
    /assignment: hasAdminPermission\(session, "ops:write"\) \? undefined : "read_only"/
  );
  for (const route of [
    "app/api/admin/amux/escalations/route.ts",
    "app/api/admin/amux/escalations/proposals/route.ts",
    "app/api/admin/amux/escalations/review/route.ts",
  ]) {
    assert.match(read(route), /hasAdminPermission\(session, "ops:write"\)/, route);
  }
  // Cards is read only by construction; tests/amuxAdminCardList.test.mjs pins
  // that the panel issues no request and the loader writes nothing.
  assert.match(execution, /cards: "read_only"/);
});
