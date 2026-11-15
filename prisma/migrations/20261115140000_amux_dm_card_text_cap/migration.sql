-- baseline-check: replace-function-if-body-sha256 "amux_decision_maker_body_guard" "91dac7cee4d8e84b27e41c90266e4a638ca391c87e2286c3d1448be1cfd12d1f" "8900b780b0fe7e9a39f5ccdfed34debd336f3f85e0b935a8e64358099991f118"
--
-- AMUX Decision Maker: one real cap per body (owner decisions 2026-11-15,
-- "4000자 제한도 없애주세요", "내부 개발용 Flow입니다. 제한을 줄 이유가 없습니다";
-- docs/policy/amux-decision-maker.md §5, §6, §10).
--
-- A Decision Maker now reads a workspace -- a checkout of the repository and
-- the whole evidence of its card (lib/amux/decisionMakerWorkspaceCore.ts) --
-- so the card is a summary and no card field has a length cap of its own. Its
-- whole card text keeps one cap, the real limit behind it: the card is the
-- vendor CLI's prompt (DM_CARD_TEXT_MAX_BYTES in lib/amux/decisionMakerCore.ts,
-- 262144 bytes). A DM's answer is never refused for its length: each of its
-- text fields, and the operator's edited answer, is held to the whole output's
-- cap (DM_OUTPUT_TEXT_MAX_BYTES, 262144 bytes, the launcher's and the results
-- route's). The body store holds the same:
--
--   AmuxDecisionMakerBody_text_size_check: card_text 262144 (was 16384),
--     dm_answer, dm_rationale, dm_escalation_reason and operator_answer 262144
--     each (were 8192, 4096, 1024 and 8192).
--   amux_decision_maker_body_guard: a request's bodies together 1310720 (was
--     40960), the five field caps' sum (DM_BODY_REQUEST_MAX_BYTES). The body is
--     its previous one (20261018120000_amux_decision_maker_delivery_gaps) with
--     only that number changed.
--
-- Only caps grow, so every row already stored passes the new CHECK and no row
-- is rewritten. The header pins the function body this was written against
-- (pg_proc.prosrc's SHA-256, scripts/baseline-presence-core.mjs) and the body
-- it writes, and the DO block below stops the migration on any other body.
--
-- Rollback, in one transaction: re-run the CREATE OR REPLACE FUNCTION of
-- 20261018120000_amux_decision_maker_delivery_gaps and recreate the CHECK with
-- its previous caps -- which fails while a body over them is kept, so a
-- rollback after the first such body means purging or keeping it.

BEGIN;

DO $pin$
DECLARE
    actual TEXT;
BEGIN
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
      INTO actual
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = pg_catalog.current_schema()
       AND p.proname = 'amux_decision_maker_body_guard'
       AND p.pronargs = 0
       AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype;
    IF actual IS DISTINCT FROM '91dac7cee4d8e84b27e41c90266e4a638ca391c87e2286c3d1448be1cfd12d1f' THEN
        RAISE EXCEPTION 'AMUX_DM_UNEXPECTED_FUNCTION_BODY %', 'amux_decision_maker_body_guard';
    END IF;
END
$pin$;

ALTER TABLE "AmuxDecisionMakerBody"
  DROP CONSTRAINT "AmuxDecisionMakerBody_text_size_check",
  ADD CONSTRAINT "AmuxDecisionMakerBody_text_size_check"
    CHECK ((
      octet_length("text") >= 1
      AND octet_length("text") <= CASE "field"
        WHEN 'card_text' THEN 262144
        WHEN 'dm_answer' THEN 262144
        WHEN 'dm_rationale' THEN 262144
        WHEN 'dm_escalation_reason' THEN 262144
        WHEN 'operator_answer' THEN 262144
        ELSE 0
      END
    ) IS TRUE);

CREATE OR REPLACE FUNCTION "amux_decision_maker_body_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    request_route TEXT;
    request_instance TEXT;
    request_created_at TIMESTAMPTZ;
    request_audit TEXT;
    closed BOOLEAN;
    registered_check TEXT;
    destroyed BOOLEAN;
    held BOOLEAN;
    retention_until TIMESTAMPTZ;
    request_bytes BIGINT;
    audited BOOLEAN;
    expected_actor TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_IMMUTABLE';
    END IF;
    -- The request's state is read after its lock.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_ISOLATION';
    END IF;

    IF TG_OP = 'DELETE' THEN
        -- The request's lock: its holds, its close and its other body writes
        -- commit before or after this delete, never beside it.
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || OLD."requestId")
        );
        EXECUTE pg_catalog.format(
            'SELECT count(*) FILTER (WHERE "kind" = ''hold_set'') > count(*) FILTER (WHERE "kind" = ''hold_release''), max("retentionUntil") FROM %I.%I WHERE "requestId" = $1',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRetentionEvent'
        ) INTO held, retention_until USING OLD."requestId";
        -- Section 10: no delete under an open hold, erase included.
        IF held THEN
            RAISE EXCEPTION 'AMUX_DM_BODY_HELD';
        END IF;
        -- (1) The expiry purge: the router's audit of this transaction, after the retention.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "action" = $1 AND "targetType" = $2 AND "targetId" = $3 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $4 AND pg_catalog.jsonb_typeof("metadata" -> ''fields'') = ''array'' AND ("metadata" -> ''fields'') ? $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING 'amux.decision.body_purge', 'AmuxDecisionMakerRequest', OLD."requestId", 'amux-decision-router', OLD."field";
        IF audited THEN
            IF retention_until IS NULL OR pg_catalog.clock_timestamp() < retention_until THEN
                RAISE EXCEPTION 'AMUX_DM_BODY_RETAINED';
            END IF;
            RETURN OLD;
        END IF;
        -- (2) The privacy erase: a person's audit of this transaction.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "action" = $1 AND "targetType" = $2 AND "targetId" = $3 AND "actorUserId" IS NOT NULL AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND pg_catalog.jsonb_typeof("metadata" -> ''fields'') = ''array'' AND ("metadata" -> ''fields'') ? $4 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING 'amux.decision.body_erase', 'AmuxDecisionMakerRequest', OLD."requestId", OLD."field";
        IF audited THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'AMUX_DM_BODY_DELETE_UNAUDITED';
    END IF;

    -- Stage S1e: an operator's answer is written for an edited confirmation,
    -- whose judgment reads the kill switch under the Decision Maker switch
    -- gate. Every Decision Maker write takes that gate before the request
    -- lock, so the answer takes it first, shared. It reads no switch here.
    IF NEW."field" = 'operator_answer' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')
        );
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW."requestId")
    );
    EXECUTE pg_catalog.format(
        'SELECT "route", "instance", "createdAt", "auditLogId" FROM %I.%I WHERE "id" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequest'
    ) INTO request_route, request_instance, request_created_at, request_audit USING NEW."requestId";
    IF request_route IS NULL THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_NO_REQUEST';
    END IF;
    -- Open and routed to a DM: a request routed to the operator is closed from
    -- its creation, and a closed one gains no body. Since stage S1e a person's
    -- judgment closes it too, so an edited answer is stored before its
    -- judgment, in the same transaction, and nothing after it. Since stage
    -- S2-2b4 an operator's direct answer closes it as well.
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "requestId" = $1 AND "kind" IN (''assign_discarded'', ''stale_close'', ''direct_answer_close'', ''confirm'', ''edit_confirm'', ''reject''))',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequestEvent'
    ) INTO closed USING NEW."requestId";
    IF request_route <> 'dm_proposal' OR closed THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_CLOSED';
    END IF;
    -- The key period of the request's creation, whose key digests everything of it.
    IF NEW."keyPeriod" <> pg_catalog.floor(EXTRACT(EPOCH FROM request_created_at) * 1000 / 2592000000)::INTEGER THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_KEY_PERIOD';
    END IF;

    -- Shared: a destruction of this period (exclusive) commits before this
    -- read, or waits for this body and then sees it.
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtext('tomverse-amux-decision-maker-key-period:' || NEW."keyPeriod"::text)
    );
    EXECUTE pg_catalog.format(
        'SELECT max("keyCheck") FILTER (WHERE "kind" = ''rotate''), coalesce(bool_or("kind" = ''destroy''), false) FROM %I.%I WHERE "keyPeriod" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerDigestKeyEvent'
    ) INTO registered_check, destroyed USING NEW."keyPeriod";
    IF registered_check IS DISTINCT FROM NEW."keyCheck" OR destroyed THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_KEY';
    END IF;

    -- Section 10: "요청당 합계는 40 KiB 이하다". Rows of the same statement
    -- written before this one are visible here.
    EXECUTE pg_catalog.format(
        'SELECT coalesce(sum(pg_catalog.octet_length("text")), 0) FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerBody'
    ) INTO request_bytes USING NEW."requestId";
    IF request_bytes + pg_catalog.octet_length(NEW."text") > 1310720 THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_REQUEST_SIZE';
    END IF;

    -- What the body belongs to, written by this very transaction.
    IF NEW."field" = 'card_text' THEN
        -- The card as routed: the request row's own route audit.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.route', 'AmuxDecisionMakerRequest', NEW."requestId", 'amux-decision-router';
        audited := audited AND NEW."auditLogId" = request_audit;
    ELSIF NEW."field" IN ('dm_answer', 'dm_rationale', 'dm_escalation_reason') THEN
        -- The DM's output: the request's result of the matching kind, and its
        -- own result audit by the request's instance.
        expected_actor := CASE request_instance
            WHEN 'decision-maker-openai' THEN 'amux-decision-maker-openai'
            WHEN 'decision-maker-anthropic' THEN 'amux-decision-maker-anthropic'
        END;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %1$I.%2$I e JOIN %1$I.%3$I a ON a."id" = e."auditLogId" WHERE e."auditLogId" = $1 AND e."requestId" = $2 AND e."kind" = ''result'' AND e."resultKind" = $3 AND e.xmin = pg_catalog.pg_current_xact_id()::xid AND a."action" = ''amux.decision.result'' AND a."targetType" = ''AmuxDecisionMakerRequestEvent'' AND a."targetId" = e."id" AND a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND a."userAgent" IS NULL AND pg_catalog.jsonb_typeof(a."metadata") = ''object'' AND a."metadata" ->> ''systemActor'' = $4 AND a.xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRequestEvent',
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", NEW."requestId",
            CASE WHEN NEW."field" = 'dm_escalation_reason' THEN 'escalate' ELSE 'proposal' END,
            expected_actor;
    ELSIF NEW."field" = 'operator_answer' THEN
        -- The operator's edited answer: a person's edit_confirm targeting the
        -- request and naming it in its metadata.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NOT NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND NOT ("metadata" ? ''systemActor'') AND "metadata" ->> ''request_id'' = $4 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.edit_confirm', 'AmuxDecisionMakerRequest', NEW."requestId";
    ELSE
        -- Not one of the five: the field CHECK refuses it as well.
        audited := false;
    END IF;
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

COMMIT;
