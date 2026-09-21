import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmuxIncidentSetting,
  serializeAmuxIncidentState,
} from "../lib/amux/incidentCore.ts";

const now = new Date("2026-09-21T12:00:00.000Z");

test("incident setting admits work only for a valid normal state", () => {
  const raw = serializeAmuxIncidentState({
    version: 1,
    state: "normal",
    transition_id: "transition-1",
    changed_at: now.toISOString(),
    reason: "Incident cleared after validation.",
    ticket: "OPS-101",
  });
  assert.deepEqual(parseAmuxIncidentSetting(raw, now), {
    state: JSON.parse(raw),
    valid: true,
    blocks_admission: false,
    problem: null,
  });
});

test("frozen, missing, malformed and ambiguous states all block admission", () => {
  const frozen = serializeAmuxIncidentState({
    version: 1,
    state: "frozen",
    transition_id: "transition-2",
    changed_at: now.toISOString(),
    reason: "Provider incident under investigation.",
    ticket: "INC-7",
  });
  assert.equal(parseAmuxIncidentSetting(frozen, now).blocks_admission, true);
  assert.equal(parseAmuxIncidentSetting(null, now).problem, "missing");
  assert.equal(parseAmuxIncidentSetting("{", now).problem, "invalid_json");
  assert.equal(
    parseAmuxIncidentSetting(
      JSON.stringify({ state: "normal", version: 1 }),
      now,
    ).problem,
    "invalid_shape",
  );
});

test("incident setting requires a canonical UTC instant", () => {
  const reading = parseAmuxIncidentSetting(
    JSON.stringify({
      version: 1,
      state: "normal",
      transition_id: null,
      changed_at: "2026-09-21",
      reason: "Initial migration state.",
      ticket: "migration",
    }),
    now,
  );
  assert.equal(reading.valid, false);
  assert.equal(reading.blocks_admission, true);
});

test("a fail-closed reading carries a null transition for approved recovery CAS", () => {
  const reading = parseAmuxIncidentSetting(undefined, now);
  assert.equal(reading.valid, false);
  assert.equal(reading.state.state, "frozen");
  assert.equal(reading.state.transition_id, null);
});
