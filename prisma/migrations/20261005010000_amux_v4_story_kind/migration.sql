-- A08: retain the approved Story subtype on the canonical card. It cannot
-- be reconstructed from kind, a draft body after purge, or an LLM claim.
ALTER TABLE "AmuxWorkItem" ADD COLUMN "storyKind" TEXT;

ALTER TABLE "AmuxWorkItem"
  ADD CONSTRAINT "AmuxWorkItem_v4_story_kind_check"
  CHECK (
    ("sourceSystem" IS DISTINCT FROM 'admin-idea-v4' AND "storyKind" IS NULL) OR
    COALESCE(("sourceSystem" IS NOT DISTINCT FROM 'admin-idea-v4' AND
      (("cardType" = 'story' AND "storyKind" IN ('general', 'bug')) OR
       ("cardType" = 'task' AND "storyKind" IS NULL))), false)
  ) NOT VALID;
