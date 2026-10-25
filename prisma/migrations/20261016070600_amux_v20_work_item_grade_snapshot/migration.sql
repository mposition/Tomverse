-- Intake v20 item 5: bind proposed and final execution grades into new Task snapshots.
BEGIN;

ALTER TABLE "AmuxWorkItem"
  DROP CONSTRAINT "AmuxWorkItem_v4_source_snapshot_shape_check",
  ADD CONSTRAINT "AmuxWorkItem_v4_source_snapshot_shape_check"
  CHECK (
    "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
    COALESCE((
      "sourceSnapshot" IS NOT NULL AND
      jsonb_typeof("sourceSnapshot") = 'object' AND
      "sourceSnapshot" ?& ARRAY['schemaVersion', 'ideaId', 'approvalId'] AND
      jsonb_typeof("sourceSnapshot"->'schemaVersion') = 'string' AND
      jsonb_typeof("sourceSnapshot"->'ideaId') = 'string' AND
      jsonb_typeof("sourceSnapshot"->'approvalId') = 'string' AND
      "sourceSnapshot"->>'schemaVersion' = 'amux-v4' AND
      "sourceSnapshot"->>'ideaId' ~ '^[A-Za-z0-9_-]{8,80}$' AND
      "sourceSnapshot"->>'approvalId' ~ '^[A-Za-z0-9_-]{8,80}$' AND
      (
        -- Preserve the exact legacy v4 snapshot accepted for existing cards.
        ("sourceSnapshot" - 'schemaVersion' - 'ideaId' - 'approvalId') = '{}'::jsonb OR
        (
          "cardType" = 'task' AND
          "sourceSnapshot" ?& ARRAY['proposedExecutionGrade', 'finalExecutionGrade'] AND
          ("sourceSnapshot" - 'schemaVersion' - 'ideaId' - 'approvalId' -
            'proposedExecutionGrade' - 'finalExecutionGrade') = '{}'::jsonb AND
          jsonb_typeof("sourceSnapshot"->'proposedExecutionGrade') = 'string' AND
          jsonb_typeof("sourceSnapshot"->'finalExecutionGrade') = 'string' AND
          "sourceSnapshot"->>'proposedExecutionGrade' IN ('routine', 'advanced', 'frontier') AND
          "sourceSnapshot"->>'finalExecutionGrade' IN ('routine', 'advanced', 'frontier')
        )
      )
    ), false)
  );

COMMIT;
