ALTER TABLE "Feedback" ADD COLUMN "answerSignal" TEXT;
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_answerSignal_check"
  CHECK ("answerSignal" IS NULL OR "answerSignal" IN ('needs_improvement', 'helpful'));
