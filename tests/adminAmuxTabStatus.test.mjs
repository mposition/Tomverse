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

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

/**
 * For each gated tab: the variable, the shipped latch, and the file where the
 * section's own route reads that variable. The latch values are imported, not
 * written here -- whether a latch is armed is the policy's decision, and this
 * test only asks that the chip follow it.
 */
const SWITCHES = {
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
    if (entry.permitName) {
      assert.ok(reader.includes(entry.permitName), `${tab}: ${entry.reader} does not use ${entry.permitName}`);
      assert.ok(status.includes(entry.permitName), `${tab}: the chip does not use ${entry.permitName}`);
    }
  }
});

test("with the variable unset every chip says the writes are closed", () => {
  for (const tab of Object.keys(SWITCHES)) {
    assert.equal(amuxSwitchedTabStatus(tab, {}), "behind_server_switch", tab);
  }
});

test("with the variable enabled a chip says open exactly when the shipped latch is armed", () => {
  for (const [tab, entry] of Object.entries(SWITCHES)) {
    const status = amuxSwitchedTabStatus(tab, { [entry.env]: "enabled" });
    assert.equal(status, entry.latch ? "server_switch_on" : "behind_server_switch", tab);
  }
});

test("only the exact value opens a switch", () => {
  for (const [tab, entry] of Object.entries(SWITCHES)) {
    for (const value of ["Enabled", "true", "1", " enabled", ""]) {
      assert.equal(
        amuxSwitchedTabStatus(tab, { [entry.env]: value }),
        "behind_server_switch",
        `${tab}=${JSON.stringify(value)}`
      );
    }
  }
});

test("an open switch is drawn for attention and a closed one is not", () => {
  const labels = {
    behind_server_switch: "behind",
    server_switch_on: "switch on",
    read_only: "read",
  };
  assert.deepEqual(
    amuxTabChips(
      { reconciliation: "behind_server_switch", "auto-promotion": "server_switch_on", cards: "read_only", assignment: undefined },
      labels
    ),
    {
      reconciliation: { label: "behind", attention: false },
      "auto-promotion": { label: "switch on", attention: true },
      cards: { label: "read", attention: false },
    }
  );
  assert.deepEqual(amuxSwitchedTabStatuses(["auto-promotion"], {}), {
    "auto-promotion": "behind_server_switch",
  });
});

test("the pages ask the switches rather than writing the state", () => {
  // The five retired tools are the Legacy tools of Safety & recovery; the page
  // reads the switch of each one that still has one rather than writing the state.
  const recovery = read("app/(site)/(application)/admin/amux-recovery/page.tsx");
  assert.ok(
    recovery.includes("amuxSwitchedTabStatuses(SWITCHED_LEGACY_SECTIONS)"),
    "amux-recovery does not read every switched legacy section's switch"
  );
  for (const section of ["reconciliation", "metadata", "recommendation", "promotion", "auto-promotion"]) {
    assert.ok(recovery.includes(`"${section}",`), `${section} is not a legacy section`);
  }
  assert.doesNotMatch(recovery, /apply off|apply_off"|server switch/i, "amux-recovery writes a state");
  assert.doesNotMatch(read("app/(site)/(application)/admin/amux-backlog/page.tsx"), /amuxSwitchedTabStatuses/);
  const settings = read("app/(site)/(application)/admin/amux-settings/page.tsx");
  // Automatic admission has no server switch: its section shows the Admin control alone.
  assert.doesNotMatch(settings, /amuxSwitchedTabStatus/);

  assert.match(settings, /<AmuxV22PromotionControl \/>/);
  assert.doesNotMatch(recovery, /AmuxV22PromotionControl/);
  const execution = read("app/(site)/(application)/admin/amux-execution/page.tsx");
  // Assignment is read only exactly when the escalation routes would refuse
  // this viewer's decisions.
  assert.match(
    execution,
    /review: hasAdminPermission\(session, "ops:write"\) \? undefined : "read_only"/
  );
  for (const route of [
    "app/api/admin/amux/escalations/route.ts",
    "app/api/admin/amux/escalations/proposals/route.ts",
    "app/api/admin/amux/escalations/review/route.ts",
  ]) {
    assert.match(read(route), /hasAdminPermission\(session, "ops:write"\)/, route);
  }
  // The guarded move is owner-only; the supplementary card list remains
  // read-only as pinned by tests/amuxAdminCardList.test.mjs.
  assert.match(execution, /cards: isOwner \? undefined : "read_only"/);
  assert.match(execution, /AmuxExecutionWorkspace canMoveCards=\{isOwner\}/);
});
