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
    database_error_code: null,
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
  assert.equal(fields.database_error_code, null);
  assert.doesNotMatch(JSON.stringify(fields), /cmuers9o9|leaked/);

  const odd = amuxRecoverFailureFields("request", { name: "not an Error" });
  assert.deepEqual(odd, { event: "amux_recover_failed", step: "request", error_name: "unknown", error_code: null, database_error_code: null });

  const badName = new Error("x");
  badName.name = "Bad name with spaces and 🙂";
  assert.equal(amuxRecoverFailureFields("request", badName).error_name, "unknown");
});

test("recover failure logs the SQLSTATE of a wrapped raw-query failure without its message", () => {
  const fields = amuxRecoverFailureFields("quota_sweep", {
    name: "PrismaClientKnownRequestError",
    code: "P2010",
    meta: { driverAdapterError: { cause: { code: "57014", message: "secret" } } },
  });
  assert.equal(fields.database_error_code, "57014");
  assert.doesNotMatch(JSON.stringify(fields), /secret/);
});

test("the recover route logs the failure fields before its opaque 500", async () => {
  const route = await readFile(
    new URL("../app/api/internal/amux/execution/recover/route.ts", import.meta.url),
    "utf8",
  );
  const log = route.indexOf('console.error("AMUX recovery failed", amuxRecoverFailureFields(step, error))');
  // The opaque body comes from the shared internal-route helper.
  const opaque = route.indexOf('return amuxInternalErrorResponse("execution_recover", error)');
  assert.ok(log > 0 && opaque > log, "the failure is logged before the opaque response");
  for (const step of ["quota_sweep", "reclaim_executions", "reclaim_claims"]) {
    assert.match(route, new RegExp(`step = "${step}";`));
  }
  assert.doesNotMatch(route, /console\.error\([^)]*error\.message/);
});
