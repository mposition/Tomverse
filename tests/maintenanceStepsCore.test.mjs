import assert from "node:assert/strict";
import test from "node:test";

import {
  createMaintenanceStepRunner,
  describeMaintenanceStepError,
  summarizeMaintenanceStepFailures,
} from "../lib/maintenanceStepsCore.ts";

// The retention job's steps are independent, and used to be awaited in one
// sequence where the first to throw ended the run. The isolation is the whole
// point of this module, so these tests are about what survives a failure rather
// than about the happy path.

test("every step runs even when an earlier one throws", async () => {
  const { step, failures } = createMaintenanceStepRunner();
  const ran = [];

  const first = await step("first", async () => {
    ran.push("first");
    throw new Error("the row that is still there tomorrow");
  });
  const second = await step("second", async () => {
    ran.push("second");
    return 7;
  });
  const third = await step("third", async () => {
    ran.push("third");
    return { count: 2 };
  });

  assert.deepEqual(ran, ["first", "second", "third"]);
  assert.equal(first, null);
  assert.equal(second, 7);
  assert.deepEqual(third, { count: 2 });
  assert.deepEqual(
    failures.map((failure) => failure.step),
    ["first"]
  );
});

// `null` is not `0`. A step that deleted nothing and a step that never ran are
// different facts, and the callers that sum these counts have to be able to
// tell them apart.
test("a failed step reports null, which a run that found nothing does not", async () => {
  const { step } = createMaintenanceStepRunner();

  assert.equal(
    await step("threw", async () => {
      throw new Error("nope");
    }),
    null
  );
  assert.equal(await step("found nothing", async () => 0), 0);
});

test("failures are recorded in the order the steps ran, each under its own name", async () => {
  const { step, failures } = createMaintenanceStepRunner();

  await step("a", async () => {
    throw new Error("first failure");
  });
  await step("b", async () => 1);
  await step("c", async () => {
    throw new Error("second failure");
  });

  assert.deepEqual(
    failures.map((failure) => failure.step),
    ["a", "c"]
  );
  assert.match(failures[0].error, /first failure/);
  assert.match(failures[1].error, /second failure/);
});

// Two steps under one name is worse than an unnamed failure: the operator reads
// the run result and goes and looks at the wrong sweep.
test("a duplicated step name is a programming error, not a silent merge", async () => {
  const { step } = createMaintenanceStepRunner();
  await step("sessions", async () => 1);
  await assert.rejects(
    step("sessions", async () => 2),
    /Duplicate maintenance step name: sessions/
  );
});

// The runner swallows the step's failure; it must not swallow its own.
test("the duplicate-name error is thrown rather than recorded as a step failure", async () => {
  const { step, failures } = createMaintenanceStepRunner();
  await step("sessions", async () => 1);
  await step("sessions", async () => 2).catch(() => undefined);
  assert.deepEqual(failures, []);
});

test("two runners do not share failures", async () => {
  const one = createMaintenanceStepRunner();
  const two = createMaintenanceStepRunner();

  await one.step("a", async () => {
    throw new Error("only one's problem");
  });

  assert.equal(one.failures.length, 1);
  assert.deepEqual(two.failures, []);
});

// The recorded error reaches an operator dashboard and an audit log, so it
// carries the error's type and message and nothing else.
test("a step error is described by type and message, capped", () => {
  assert.equal(
    describeMaintenanceStepError(new TypeError("cannot read x")),
    "TypeError: cannot read x"
  );
  assert.equal(describeMaintenanceStepError("a thrown string"), "a thrown string");
  assert.equal(describeMaintenanceStepError(undefined), "undefined");

  const long = describeMaintenanceStepError(new Error("x".repeat(5_000)));
  assert.equal(long.length, 500);
});

test("a step error never carries the stack", () => {
  const error = new Error("boom");
  const described = describeMaintenanceStepError(error);
  assert.equal(described.includes("at "), false);
  assert.equal(described.includes(import.meta.filename ?? "maintenanceStepsCore"), false);
});

test("the summary names every failed step", () => {
  const summary = summarizeMaintenanceStepFailures([
    { step: "expired_sessions", error: "Error: down" },
    { step: "credit_lot_expiry", error: "Error: also down" },
  ]);

  assert.match(summary, /2 maintenance step\(s\) failed/);
  assert.match(summary, /expired_sessions \(Error: down\)/);
  assert.match(summary, /credit_lot_expiry \(Error: also down\)/);
});
