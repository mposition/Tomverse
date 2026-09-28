import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { amuxRecoverFailureFields } from "../lib/amux/recoverFailure.ts";

test("recover failure fields name the step and a Prisma or boundary code only", () => {
  const prisma = Object.assign(new Error("Transaction already closed: secret text"), {
    name: "PrismaClientKnownRequestError",
    code: "P2028",
  });
  assert.deepEqual(amuxRecoverFailureFields("reclaim_executions", prisma), {
    event: "amux_recover_failed",
    step: "reclaim_executions",
    error_name: "PrismaClientKnownRequestError",
    error_code: "P2028",
  });

  const boundary = Object.assign(new Error("AMUX_DB_DEADLINE_EXCEEDED:executionSettle"), {
    name: "AmuxDbBoundaryError",
    code: "AMUX_DB_DEADLINE_EXCEEDED",
  });
  assert.equal(amuxRecoverFailureFields("reclaim_claims", boundary).error_code, "AMUX_DB_DEADLINE_EXCEEDED");
});

test("recover failure fields never carry the message or an arbitrary code", () => {
  const fields = amuxRecoverFailureFields(
    "quota_sweep",
    Object.assign(new Error("task cmuers9o900mb02nzbuhb3yc4 leaked"), { code: "task cmuers9o900mb02nzbuhb3yc4" }),
  );
  assert.equal(fields.error_code, null);
  assert.doesNotMatch(JSON.stringify(fields), /cmuers9o9|leaked/);

  const odd = amuxRecoverFailureFields("request", { name: "not an Error" });
  assert.deepEqual(odd, { event: "amux_recover_failed", step: "request", error_name: "unknown", error_code: null });

  const badName = new Error("x");
  badName.name = "Bad name with spaces and 🙂";
  assert.equal(amuxRecoverFailureFields("request", badName).error_name, "unknown");
});

test("the recover route logs the failure fields before its opaque 500", async () => {
  const route = await readFile(
    new URL("../app/api/internal/amux/execution/recover/route.ts", import.meta.url),
    "utf8",
  );
  const log = route.indexOf('console.error("AMUX recovery failed", amuxRecoverFailureFields(step, error))');
  const opaque = route.indexOf('{ error: "AMUX recovery is unavailable." }');
  assert.ok(log > 0 && opaque > log, "the failure is logged before the opaque response");
  for (const step of ["quota_sweep", "reclaim_executions", "reclaim_claims"]) {
    assert.match(route, new RegExp(`step = "${step}";`));
  }
  assert.doesNotMatch(route, /console\.error\([^)]*error\.message/);
});
