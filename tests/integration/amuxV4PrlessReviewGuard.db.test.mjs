import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const dedicated = (() => {
  if (!databaseUrl || process.env.DATABASE_URL !== databaseUrl) return false;
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name);
})();

// The real v4 card/assignment fixture spans many independent ledgers. These
// transaction-local tables exercise the installed trigger's exact SQL without
// bypassing production constraints or persisting a synthetic approval row.
test("v4 PR-less proposal guard accepts only the latest retained non-code result", {
  skip: dedicated ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout = '5s'");
    await db.query(`CREATE TEMP TABLE "AmuxWorkItem" (
      "id" text PRIMARY KEY, "sourceSystem" text, "cardType" text,
      "taskRole" text, "reviewPrNumber" integer,
      "v4TitleDigest" text, "v4BodyDigest" text, "v4BriefDigest" text,
      "v4TitleCiphertext" bytea, "v4BodyCiphertext" bytea,
      "v4BriefCiphertext" bytea) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE "AmuxV22TaskResult" (
      "attemptId" text PRIMARY KEY, "taskId" text, "createdAt" timestamp,
      "bodyPurgedAt" timestamp, "ciphertext" bytea,
      "keyId" text, "keyVersion" integer) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE "AmuxExecutionAttempt" (
      "id" text PRIMARY KEY, "taskId" text,
      "v22AssignmentId" text) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE "AmuxReviewProposal" (
      "taskId" text, "attemptId" text, "outcome" text,
      "reviewPrNumber" integer) ON COMMIT DROP`);
    await db.query(`CREATE TRIGGER amux_v4_guard_test
      BEFORE INSERT ON pg_temp."AmuxReviewProposal" FOR EACH ROW
      EXECUTE FUNCTION public.amux_review_v4_prless_source_guard()`);
    await db.query(`INSERT INTO pg_temp."AmuxWorkItem" VALUES
      ('card', 'admin-idea-v4', 'task', 'design', NULL,
       'title', 'body', 'brief', '\\x01', '\\x02', '\\x03')`);
    await db.query(`INSERT INTO pg_temp."AmuxExecutionAttempt" VALUES
      ('attempt', 'card', 'assignment')`);
    await db.query(`INSERT INTO pg_temp."AmuxV22TaskResult" VALUES
      ('attempt', 'card', CURRENT_TIMESTAMP, NULL, '\\x04', 'key', 1)`);
    const insert = `INSERT INTO pg_temp."AmuxReviewProposal"
      ("taskId", "attemptId", "outcome", "reviewPrNumber")
      VALUES ('card', 'attempt', 'approve', NULL)`;
    await db.query(insert);
    const count = await db.query(`SELECT count(*)::int AS total
      FROM pg_temp."AmuxReviewProposal"`);
    assert.equal(count.rows[0].total, 1);

    const reject = async (change) => {
      await db.query("SAVEPOINT probe");
      await db.query(change);
      let error;
      try { await db.query(insert); } catch (caught) { error = caught; }
      await db.query("ROLLBACK TO SAVEPOINT probe");
      await db.query("RELEASE SAVEPOINT probe");
      assert.equal(error?.code, "23514", error?.message);
    };
    await reject(`UPDATE pg_temp."AmuxWorkItem"
      SET "taskRole" = 'implement' WHERE "id" = 'card'`);
    await reject(`UPDATE pg_temp."AmuxWorkItem"
      SET "reviewPrNumber" = 42 WHERE "id" = 'card'`);
    await reject(`UPDATE pg_temp."AmuxV22TaskResult"
      SET "bodyPurgedAt" = CURRENT_TIMESTAMP WHERE "attemptId" = 'attempt'`);
    await reject(`INSERT INTO pg_temp."AmuxV22TaskResult" VALUES
      ('newer', 'card', CURRENT_TIMESTAMP + INTERVAL '1 second',
       NULL, '\\x05', 'key', 1)`);
    await reject(`UPDATE pg_temp."AmuxExecutionAttempt"
      SET "v22AssignmentId" = NULL WHERE "id" = 'attempt'`);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
});
