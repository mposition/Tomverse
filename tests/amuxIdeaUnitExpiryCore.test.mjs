import assert from "node:assert/strict";
import test from "node:test";

import { mayExpireAmuxPreparedUnit } from
  "../lib/amux/ideaUnitExpiryService.ts";

test("expired prepared unit can be replaced, while live and unknown units cannot", () => {
  const expiry = new Date("2026-10-03T01:15:00.000Z");
  const row = { state: "prepared", expiresAt: expiry, outcomeUnknownAt: null };
  assert.equal(mayExpireAmuxPreparedUnit(row, expiry), true);
  assert.equal(mayExpireAmuxPreparedUnit(row,
    new Date("2026-10-03T01:14:59.999Z")), false);
  assert.equal(mayExpireAmuxPreparedUnit({ ...row, state: "consumed" }, expiry), false);
  assert.equal(mayExpireAmuxPreparedUnit({ ...row,
    outcomeUnknownAt: new Date("2026-10-03T01:14:00.000Z") }, expiry), false);
  assert.equal(mayExpireAmuxPreparedUnit({ ...row,
    expiresAt: new Date(NaN) }, expiry), false);
});
