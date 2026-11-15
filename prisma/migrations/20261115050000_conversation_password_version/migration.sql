-- Keep password changes and grant invalidation atomic, including old app
-- instances and the legacy-password migration script during rolling deploys.
ALTER TABLE "Conversation" ADD COLUMN "passwordVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExternalConversation" ADD COLUMN "passwordVersion" INTEGER NOT NULL DEFAULT 0;

CREATE FUNCTION "advance_conversation_password_version"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."passwordVersion" := OLD."passwordVersion" +
    CASE WHEN NEW."password" IS DISTINCT FROM OLD."password" THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "conversation_password_version"
BEFORE UPDATE ON "Conversation"
FOR EACH ROW EXECUTE FUNCTION "advance_conversation_password_version"();

CREATE TRIGGER "external_conversation_password_version"
BEFORE UPDATE ON "ExternalConversation"
FOR EACH ROW EXECUTE FUNCTION "advance_conversation_password_version"();
