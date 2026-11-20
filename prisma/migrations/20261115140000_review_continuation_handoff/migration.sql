ALTER TABLE "ChatResponseAttempt"
ADD COLUMN "continuationSourcePlan" JSONB;

ALTER TABLE "ConversationContinuationBridge"
ADD COLUMN "reviewHandoff" JSONB;

ALTER TABLE "ChatResponseAttempt"
ADD CONSTRAINT "ChatResponseAttempt_continuationSourcePlan_object_check"
CHECK (
  "continuationSourcePlan" IS NULL
  OR jsonb_typeof("continuationSourcePlan") = 'object'
);

ALTER TABLE "ConversationContinuationBridge"
ADD CONSTRAINT "ConversationContinuationBridge_reviewHandoff_object_check"
CHECK (
  "reviewHandoff" IS NULL
  OR jsonb_typeof("reviewHandoff") = 'object'
);
