import { randomUUID } from "node:crypto";

/** Test fixture only. The hash is deliberately synthetic, not an HMAC; these
 * schema tests check FK/actor guards, not canonical audit verification. It
 * still links to the database chain head so the append-only trigger accepts
 * the row and the test cannot bypass the production chain-order constraint. */
export async function appendSyntheticAdminAudit(client, {
  actorUserId, action, targetType, targetId, summary, metadata = null,
  entryHash = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
}) {
  const id = randomUUID();
  // Synthetic hashes must never become durable chain evidence. The caller
  // must own a rollback-only transaction; SAVEPOINT refuses autocommit use.
  await client.query("SAVEPOINT synthetic_admin_audit_transaction_required");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))");
  await client.query(
    `WITH head AS (
       SELECT "entryHash", "createdAt" FROM public."AdminAuditLog"
       WHERE "entryHash" IS NOT NULL
       ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
     )
     INSERT INTO public."AdminAuditLog"
       ("id", "actorUserId", "action", "targetType", "targetId", "summary",
        "metadata", "previousHash", "entryHash", "createdAt")
     SELECT $1, $2, $3, $4, $5, $6, $7::jsonb,
            (SELECT "entryHash" FROM head), $8,
            GREATEST((clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3),
              COALESCE((SELECT "createdAt" FROM head) + INTERVAL '1 millisecond',
                '-infinity'::timestamp))`,
    [id, actorUserId, action, targetType, targetId, summary,
      metadata === null ? null : JSON.stringify(metadata), entryHash],
  );
  await client.query("RELEASE SAVEPOINT synthetic_admin_audit_transaction_required");
  return id;
}
