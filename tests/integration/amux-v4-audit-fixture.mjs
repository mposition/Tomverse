import { randomUUID } from "node:crypto";

// Test-only SQL fixture. Call inside a transaction that is rolled back by the
// caller, so synthetic hashes never become durable audit evidence.
export async function insertSyntheticAmuxAudit(client, {
  actorUserId,
  action,
  targetType,
  targetId,
  summary,
  metadata = null,
  entryHash = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
}) {
  // SAVEPOINT fails under autocommit; the lock and synthetic row must remain
  // inside the caller's rollback-only transaction.
  await client.query("SAVEPOINT amux_v4_audit_fixture_transaction_required");
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))`,
  );
  const { rows: [head] } = await client.query(
    `SELECT "entryHash"
     FROM public."AdminAuditLog"
     WHERE "entryHash" IS NOT NULL
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT 1`,
  );
  const id = randomUUID();
  await client.query(
    `INSERT INTO public."AdminAuditLog"
     ("id", "actorUserId", "action", "targetType", "targetId", "summary",
      "metadata", "previousHash", "entryHash", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
       GREATEST(
         (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
         COALESCE((
           SELECT "createdAt" + INTERVAL '1 millisecond'
           FROM public."AdminAuditLog"
           WHERE "entryHash" IS NOT NULL
           ORDER BY "createdAt" DESC, "id" DESC
           LIMIT 1
         ), '-infinity'::timestamp)
       ))`,
    [id, actorUserId, action, targetType, targetId, summary,
      metadata === null ? null : JSON.stringify(metadata),
      head?.entryHash ?? null, entryHash],
  );
  await client.query("RELEASE SAVEPOINT amux_v4_audit_fixture_transaction_required");
  return id;
}
