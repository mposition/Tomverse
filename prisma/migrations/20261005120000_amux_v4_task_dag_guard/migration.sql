-- v4 Task edges are the exact owner-confirmed set, not a mutable scheduling
-- hint. Legacy dependencies retain their existing behavior.
-- baseline-check: present-if-function "amux_v4_task_dag_check"
CREATE FUNCTION amux_v4_task_dag_check(p_task_id text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_task "AmuxWorkItem"%ROWTYPE;
  v_decision "AmuxIdeaUnitDecision"%ROWTYPE;
  v_expected text[];
  v_actual text[];
BEGIN
  SELECT * INTO v_task FROM "AmuxWorkItem" WHERE "id" = p_task_id;
  IF v_task."id" IS NULL OR v_task."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' THEN
    RETURN;
  END IF;
  IF v_task."cardType" = 'story' THEN
    IF EXISTS (SELECT 1 FROM "AmuxWorkDependency" WHERE "taskId" = p_task_id) THEN
      RAISE EXCEPTION 'AMUX v4 Story cannot depend on a Task'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_story_check';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO v_decision FROM "AmuxIdeaUnitDecision"
    WHERE "id" = v_task."v4SourceApprovalId";
  IF v_task."cardType" NOT IN ('story', 'task') OR
     v_decision."id" IS NULL OR v_decision."action" IS DISTINCT FROM 'register_card' OR
     v_decision."state" IS DISTINCT FROM 'consumed' OR
     v_decision."registeredWorkItemId" IS DISTINCT FROM v_task."id" OR
     v_decision."confirmationSnapshot"->'card'->>'cardType' IS DISTINCT FROM v_task."cardType" THEN
    RAISE EXCEPTION 'AMUX v4 Task approval is incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_approval_check';
  END IF;
  IF jsonb_typeof(v_decision."confirmationSnapshot"->'card'->'dependencies') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AMUX v4 Task dependency receipt is missing'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_receipt_check';
  END IF;
  SELECT COALESCE(array_agg(value->>'id' ORDER BY value->>'id'), ARRAY[]::text[])
    INTO v_expected
    FROM jsonb_array_elements(v_decision."confirmationSnapshot"->'card'->'dependencies') AS value;
  SELECT COALESCE(array_agg("dependencyId" ORDER BY "dependencyId"), ARRAY[]::text[])
    INTO v_actual FROM "AmuxWorkDependency" WHERE "taskId" = p_task_id;
  IF v_expected IS DISTINCT FROM v_actual OR
     EXISTS (SELECT 1 FROM jsonb_array_elements(v_decision."confirmationSnapshot"->'card'->'dependencies') AS value
       WHERE jsonb_typeof(value) IS DISTINCT FROM 'object' OR
             value->>'cardType' IS DISTINCT FROM 'task' OR
             value->>'sourceSystem' IS DISTINCT FROM 'admin-idea-v4') OR
     EXISTS (SELECT 1 FROM "AmuxWorkDependency" d
       LEFT JOIN "AmuxWorkItem" dependency ON dependency."id" = d."dependencyId"
       LEFT JOIN "AmuxIdeaUnitDecision" approval ON approval."id" = dependency."v4SourceApprovalId"
       WHERE d."taskId" = p_task_id AND
         (dependency."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
          dependency."cardType" IS DISTINCT FROM 'task' OR
          approval."state" IS DISTINCT FROM 'consumed' OR
          approval."action" IS DISTINCT FROM 'register_card' OR
          approval."registeredWorkItemId" IS DISTINCT FROM dependency."id")) THEN
    RAISE EXCEPTION 'AMUX v4 Task dependency differs from owner approval'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_edges_check';
  END IF;
  IF EXISTS (
    WITH RECURSIVE walk(id) AS (
      SELECT d."dependencyId"
        FROM "AmuxWorkDependency" d WHERE d."taskId" = p_task_id
      UNION
      SELECT d."dependencyId"
        FROM walk JOIN "AmuxWorkDependency" d ON d."taskId" = walk.id
    ) SELECT 1 FROM walk WHERE id = p_task_id
  ) THEN
    RAISE EXCEPTION 'AMUX v4 Task dependency cycle'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_cycle_check';
  END IF;
END;
$$;

CREATE FUNCTION amux_v4_task_dag_decision_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM amux_v4_task_dag_check(NEW."registeredWorkItemId");
  RETURN NEW;
END;
$$;

CREATE FUNCTION amux_v4_task_dag_edge_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM amux_v4_task_dag_check(OLD."taskId"); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM amux_v4_task_dag_check(NEW."taskId"); END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER amux_v4_task_dag_decision
AFTER INSERT OR UPDATE ON "AmuxIdeaUnitDecision"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."state" = 'consumed' AND NEW."action" = 'register_card')
EXECUTE FUNCTION amux_v4_task_dag_decision_trigger();

CREATE CONSTRAINT TRIGGER amux_v4_task_dag_edge
AFTER INSERT OR UPDATE OR DELETE ON "AmuxWorkDependency"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION amux_v4_task_dag_edge_trigger();

-- Until a new owner-approved revision writer exists, an approved Task cannot
-- silently replace the brief/scope digest, role, grade or parent binding.
CREATE FUNCTION amux_v4_task_approval_binding_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."sourceSystem" = 'admin-idea-v4' AND OLD."cardType" = 'task' AND
     (NEW."sourceSystem" IS DISTINCT FROM OLD."sourceSystem" OR
      NEW."sourceDigest" IS DISTINCT FROM OLD."sourceDigest" OR
      NEW."v4SourceApprovalId" IS DISTINCT FROM OLD."v4SourceApprovalId" OR
      NEW."v4BodyDigest" IS DISTINCT FROM OLD."v4BodyDigest" OR
      NEW."v4BodyDigestKeyId" IS DISTINCT FROM OLD."v4BodyDigestKeyId" OR
      NEW."v4BriefDigest" IS DISTINCT FROM OLD."v4BriefDigest" OR
      NEW."v4BriefDigestKeyId" IS DISTINCT FROM OLD."v4BriefDigestKeyId" OR
      NEW."taskRole" IS DISTINCT FROM OLD."taskRole" OR
      NEW."executionGrade" IS DISTINCT FROM OLD."executionGrade" OR
      NEW."parentFeatureNodeId" IS DISTINCT FROM OLD."parentFeatureNodeId" OR
      NEW."parentStoryCardId" IS DISTINCT FROM OLD."parentStoryCardId") THEN
    RAISE EXCEPTION 'AMUX v4 Task approval binding is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_binding_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amux_v4_task_approval_binding
BEFORE UPDATE ON "AmuxWorkItem"
FOR EACH ROW EXECUTE FUNCTION amux_v4_task_approval_binding_guard();

CREATE FUNCTION amux_v4_task_dag_truncate_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AmuxWorkItem"
    WHERE "sourceSystem" = 'admin-idea-v4' AND "cardType" = 'task') THEN
    RAISE EXCEPTION 'AMUX v4 Task dependencies cannot be truncated'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_no_truncate_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER amux_v4_task_dag_no_truncate
BEFORE TRUNCATE ON "AmuxWorkDependency"
FOR EACH STATEMENT EXECUTE FUNCTION amux_v4_task_dag_truncate_guard();
