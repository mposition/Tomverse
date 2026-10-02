import assert from "node:assert/strict";
import test from "node:test";

import { appendSyntheticAdminAudit } from "./integration/helpers/appendSyntheticAdminAudit.mjs";

const input = { actorUserId: "synthetic-owner", action: "synthetic.probe",
  targetType: "Synthetic", targetId: "target", summary: "rollback-only fixture" };

test("synthetic audit fixture refuses callers without a transaction before writing", async () => {
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    throw new Error("SAVEPOINT can only be used in transaction blocks");
  } };
  await assert.rejects(appendSyntheticAdminAudit(client, input), /SAVEPOINT/);
  assert.deepEqual(calls, ["SAVEPOINT synthetic_admin_audit_transaction_required"]);
});

test("synthetic audit fixture brackets its write with a transaction savepoint", async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); } };
  await appendSyntheticAdminAudit(client, input);
  assert.equal(calls[0], "SAVEPOINT synthetic_admin_audit_transaction_required");
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.match(calls[2], /INSERT INTO public\."AdminAuditLog"/);
  assert.equal(calls[3], "RELEASE SAVEPOINT synthetic_admin_audit_transaction_required");
});
