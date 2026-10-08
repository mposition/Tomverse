import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(databaseName);
})();

test("v22 encrypted patch candidate is bounded and bound to one Task result", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const digest = "a".repeat(64);
  const insert = `INSERT INTO public."AmuxV22TaskPatch"
    ("attemptId", "taskId", "ideaId", "ciphertext", "keyId",
     "keyVersion", "digest", "digestKeyId", "patchSha256",
     "baseSha", "byteLength")
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'synthetic', $8, $9, $10)`;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  async function reject(parameters, expectedCode, expectedConstraint) {
    await client.query("SAVEPOINT probe");
    let error;
    try { await client.query(insert, parameters); }
    catch (caught) { error = caught; }
    await client.query("ROLLBACK TO SAVEPOINT probe");
    await client.query("RELEASE SAVEPOINT probe");
    assert.equal(error?.code, expectedCode, error?.message);
    if (expectedConstraint) assert.equal(error.constraint, expectedConstraint);
  }
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await reject([...ids, null, null, null, digest, digest,
      "b".repeat(40), 1], "23514", "AmuxV22TaskPatch_body_check");
    await reject([...ids, Buffer.from("x"), "synthetic", 1,
      digest, digest, "b".repeat(40), 65_537], "23514",
    "AmuxV22TaskPatch_digest_check");
    await reject([...ids, Buffer.from("x"), "synthetic", 1,
      digest, digest, "b".repeat(40), 1], "23503");
    const trigger = await client.query(`SELECT count(*)::int AS count
      FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid
      WHERE t.relname = 'AmuxV22TaskPatch' AND NOT g.tgisinternal`);
    assert.equal(trigger.rows[0].count, 1);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
