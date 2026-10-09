-- Transient server-owned bodies; terminal rows are content-free tombstones.
CREATE TABLE "PromptRefinerChatScope" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "mountId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "surface" TEXT NOT NULL CHECK ("surface" IN ('chat', 'workspace')),
  "epoch" INTEGER NOT NULL CHECK ("epoch" > 0),
  UNIQUE ("userId", "mountId")
);
CREATE FUNCTION "guard_prompt_refiner_chat_scope"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = NEW."conversationId"
      AND c."userId" = NEW."userId" AND c."kind" = 'chat' AND c."productKey" = 'chat')
    OR (TG_OP = 'INSERT' AND NEW."epoch" <> 1) THEN
    RAISE EXCEPTION 'prompt_refiner_chat_scope_invalid';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."mountId" IS DISTINCT FROM OLD."mountId"
      OR NEW."epoch" <> OLD."epoch" + 1) THEN
    RAISE EXCEPTION 'prompt_refiner_chat_scope_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PromptRefinerChatScope_guard" BEFORE INSERT OR UPDATE ON "PromptRefinerChatScope"
  FOR EACH ROW EXECUTE FUNCTION "guard_prompt_refiner_chat_scope"();
CREATE TABLE "PromptRefinerChatSuggestion" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "surface" TEXT NOT NULL CHECK ("surface" IN ('chat', 'workspace')),
  "scopeId" TEXT NOT NULL REFERENCES "PromptRefinerChatScope"("id") ON DELETE CASCADE,
  "scopeEpoch" INTEGER NOT NULL CHECK ("scopeEpoch" > 0),
  "recoveryEpoch" INTEGER NOT NULL CHECK ("recoveryEpoch" >= 0),
  "draftId" TEXT NOT NULL,
  "draftRevision" INTEGER NOT NULL CHECK ("draftRevision" > 0),
  "sourceMessageId" TEXT NOT NULL,
  "sourcePrompt" TEXT,
  "refinedPrompt" TEXT,
  "requestId" TEXT NOT NULL UNIQUE,
  "refinerVersion" TEXT NOT NULL CHECK ("refinerVersion" ~ '^suggest-v[1-9][0-9]{0,3}$'),
  "mode" TEXT NOT NULL CHECK ("mode" IN ('explicit', 'auto')),
  "state" TEXT NOT NULL CHECK ("state" IN ('ready', 'consumed', 'stale')),
  "decision" TEXT CHECK ("decision" IN ('accepted', 'kept_original')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '5 minutes'),
  CHECK (("state" = 'ready' AND "sourcePrompt" IS NOT NULL AND "refinedPrompt" IS NOT NULL
    AND "decision" IS NULL AND "consumedAt" IS NULL)
    OR ("state" = 'consumed' AND "sourcePrompt" IS NULL AND "refinedPrompt" IS NULL
      AND "decision" IS NOT NULL AND "consumedAt" IS NOT NULL AND "consumedAt" < "expiresAt")
    OR ("state" = 'stale' AND "sourcePrompt" IS NULL AND "refinedPrompt" IS NULL
      AND "decision" IS NULL AND "consumedAt" IS NULL)),
  CHECK ("sourcePrompt" IS NULL OR (octet_length("sourcePrompt") <= 32768 AND length("sourcePrompt") <= 16000)),
  CHECK ("refinedPrompt" IS NULL OR (octet_length("refinedPrompt") <= 32768 AND length("refinedPrompt") <= 16000))
);
CREATE INDEX "PromptRefinerChatSuggestion_scopeId_state_idx" ON "PromptRefinerChatSuggestion" ("scopeId", "state");
CREATE INDEX "PromptRefinerChatSuggestion_draftId_state_idx" ON "PromptRefinerChatSuggestion" ("draftId", "state");
CREATE INDEX "PromptRefinerChatSuggestion_expiresAt_state_idx" ON "PromptRefinerChatSuggestion" ("expiresAt", "state");

CREATE FUNCTION "guard_prompt_refiner_chat_suggestion"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE scope_row "PromptRefinerChatScope"; draft_row "ChatComposerDraft";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO scope_row FROM "PromptRefinerChatScope" WHERE "id" = NEW."scopeId" FOR UPDATE;
    SELECT * INTO draft_row FROM "ChatComposerDraft" WHERE "id" = NEW."draftId" FOR SHARE;
    IF NEW."state" <> 'ready' OR scope_row."userId" IS DISTINCT FROM NEW."userId"
      OR scope_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR scope_row."surface" IS DISTINCT FROM NEW."surface" OR scope_row."epoch" IS DISTINCT FROM NEW."scopeEpoch"
      OR draft_row."userId" IS DISTINCT FROM NEW."userId" OR draft_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR draft_row."revision" IS DISTINCT FROM NEW."draftRevision" OR draft_row."text" IS DISTINCT FROM NEW."sourcePrompt"
      OR NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = NEW."conversationId" AND c."userId" = NEW."userId"
        AND c."kind" = 'chat' AND c."productKey" = 'chat' AND c."chatRecoveryEpoch" = NEW."recoveryEpoch") THEN
      RAISE EXCEPTION 'prompt_refiner_chat_binding_invalid';
    END IF;
    NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
    NEW."expiresAt" := NEW."createdAt" + INTERVAL '5 minutes';
  ELSE
    IF OLD."state" <> 'ready' OR NEW."state" NOT IN ('consumed', 'stale')
      OR (to_jsonb(NEW) - ARRAY['state', 'decision', 'consumedAt', 'sourcePrompt', 'refinedPrompt'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'decision', 'consumedAt', 'sourcePrompt', 'refinedPrompt']) THEN
      RAISE EXCEPTION 'prompt_refiner_chat_immutable';
    END IF;
    NEW."sourcePrompt" := NULL; NEW."refinedPrompt" := NULL;
    IF NEW."state" = 'consumed' THEN
      NEW."consumedAt" := clock_timestamp() AT TIME ZONE 'UTC';
      IF NEW."consumedAt" >= OLD."expiresAt" THEN RAISE EXCEPTION 'prompt_refiner_chat_expired'; END IF;
    ELSE NEW."decision" := NULL; NEW."consumedAt" := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PromptRefinerChatSuggestion_guard" BEFORE INSERT OR UPDATE ON "PromptRefinerChatSuggestion"
  FOR EACH ROW EXECUTE FUNCTION "guard_prompt_refiner_chat_suggestion"();

-- An edit invalidates irrevocably, even when bytes later return to the snapshot.
CREATE FUNCTION "invalidate_prompt_refiner_chat_draft"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE "PromptRefinerChatSuggestion" SET "state" = 'stale', "sourcePrompt" = NULL, "refinedPrompt" = NULL
      WHERE "draftId" = OLD."id" AND "state" = 'ready';
  ELSE
    UPDATE "PromptRefinerChatSuggestion" s SET "state" = 'stale', "sourcePrompt" = NULL, "refinedPrompt" = NULL
      WHERE s."draftId" = OLD."id" AND s."state" = 'ready' AND NOT EXISTS
        (SELECT 1 FROM "Message" m WHERE m."id" = s."sourceMessageId"
          AND m."conversationId" = OLD."conversationId" AND m."role" = 'user' AND m."content" = OLD."text");
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "PromptRefinerChatSuggestion_draft_edit" AFTER UPDATE ON "ChatComposerDraft"
  FOR EACH ROW EXECUTE FUNCTION "invalidate_prompt_refiner_chat_draft"();
-- Message save consumes the draft before inserting the Message, so check at COMMIT.
CREATE CONSTRAINT TRIGGER "PromptRefinerChatSuggestion_draft_delete" AFTER DELETE ON "ChatComposerDraft"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "invalidate_prompt_refiner_chat_draft"();
