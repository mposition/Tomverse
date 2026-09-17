-- The admin audit log is append-only, and a hashed entry can only join the
-- chain at its head.
--
-- Contract: docs/policy/marketing-automation.md §6 -- human and system actions
-- share one hash chain written through lib/adminAudit.ts, and direct writes to
-- the table are forbidden. `npm run check:protected-table-writers` refuses the
-- direct writes it can read in source; this migration makes the property hold
-- for writes it cannot read -- a delegate reached through an alias, a
-- transaction callback, or SQL assembled at run time -- because the database
-- checks every row however it arrived.
--
-- What it enforces:
--
-- 1. No UPDATE and no DELETE, for any row. Nothing in the application updates
--    or deletes audit entries, and 20260826070000 removed the one foreign-key
--    action that used to. TRUNCATE is a statement-level operation that row
--    triggers do not see; it stays available to test databases, and a
--    production TRUNCATE is a schema-owner action outside the application.
--    The approved 7-year retention (a future purge that keeps an anchor hash)
--    will need its own reviewed exception here when it is built.
--
-- 2. A row that carries an entryHash takes the chain lock, and must link to
--    the current head: its previousHash equals the newest hashed row's
--    entryHash (NULL when there is none), and its createdAt is strictly later
--    than that row's. Strictly: the chain is ordered by (createdAt, id) and ids
--    are random, so an entry in the head's millisecond could sort before the
--    head and fork the chain for the next writer. lib/adminAudit.ts stamps a
--    hashed entry at least one millisecond after the head and takes the same
--    advisory lock first, so it is unaffected; the lock is re-entrant within a
--    transaction. An inserter that skips the lock or links to an older entry is
--    refused instead of forking the chain.
--
-- Both functions pin search_path to the schema they were created in, so a
-- caller's search_path cannot point the head read at another table.
--
-- What it does not do: verify the HMAC. The key lives in the application, not
-- the database. A row with no entryHash (written where no integrity key is
-- configured, or by a test fixture) is accepted and, as before, is not part of
-- what verification covers.

CREATE OR REPLACE FUNCTION "admin_audit_log_is_append_only"()
RETURNS trigger
SET search_path FROM CURRENT
AS $$
BEGIN
    RAISE EXCEPTION 'AdminAuditLog is append-only: % of entry % refused', TG_OP, OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_audit_log_is_append_only"
    BEFORE UPDATE OR DELETE ON "AdminAuditLog"
    FOR EACH ROW
    EXECUTE FUNCTION "admin_audit_log_is_append_only"();

CREATE OR REPLACE FUNCTION "admin_audit_log_links_to_head"()
RETURNS trigger
SET search_path FROM CURRENT
AS $$
DECLARE
    head_hash TEXT;
    head_created_at TIMESTAMP(3);
BEGIN
    IF NEW."entryHash" IS NULL THEN
        IF NEW."previousHash" IS NOT NULL THEN
            RAISE EXCEPTION 'AdminAuditLog entry % has a previousHash but no entryHash', NEW."id"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- Same lock as lib/adminAudit.ts, so the head read below cannot race
    -- another hashed insert.
    PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));

    SELECT "entryHash", "createdAt"
      INTO head_hash, head_created_at
      FROM "AdminAuditLog"
     WHERE "entryHash" IS NOT NULL
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT 1;

    IF NEW."previousHash" IS DISTINCT FROM head_hash THEN
        RAISE EXCEPTION 'AdminAuditLog entry % does not link to the chain head', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF head_created_at IS NOT NULL AND NEW."createdAt" <= head_created_at THEN
        RAISE EXCEPTION 'AdminAuditLog entry % is not dated after the chain head', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_audit_log_links_to_head"
    BEFORE INSERT ON "AdminAuditLog"
    FOR EACH ROW
    EXECUTE FUNCTION "admin_audit_log_links_to_head"();
