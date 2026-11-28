import assert from "node:assert/strict";
import { test } from "node:test";
import { retryOnceOnUniqueConstraint } from "../lib/databaseError.ts";

const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

test("a unique-constraint race is retried once and the second attempt's result is returned", async () => {
  let calls = 0;
  const result = await retryOnceOnUniqueConstraint(async () => {
    calls += 1;
    if (calls === 1) throw uniqueViolation();
    return "updated";
  });
  assert.equal(result, "updated");
  assert.equal(calls, 2);
});

test("a write that succeeds is not repeated", async () => {
  let calls = 0;
  assert.equal(await retryOnceOnUniqueConstraint(async () => { calls += 1; return "created"; }), "created");
  assert.equal(calls, 1);
});

test("only one retry: a second conflict surfaces", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnceOnUniqueConstraint(async () => { calls += 1; throw uniqueViolation(); }),
    { code: "P2002" }
  );
  assert.equal(calls, 2);
});

test("any other error is never retried", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnceOnUniqueConstraint(async () => { calls += 1; throw Object.assign(new Error("fk"), { code: "P2003" }); }),
    { code: "P2003" }
  );
  assert.equal(calls, 1);
});
