-- Owner direction 2026-11-15: an AMUX idea's title is the whole first non-blank
-- line of its body (lib/amux/ideaTitleCore.ts), no longer cut to 80 characters
-- with an ellipsis. No index covers the column, so a title has no length limit
-- of its own. The title still lives no longer than the body: a purged row holds
-- none, exactly as before.
ALTER TABLE "AmuxIdeaSubmission"
  DROP CONSTRAINT "AmuxIdeaSubmission_title_check",
  ADD CONSTRAINT "AmuxIdeaSubmission_title_check" CHECK (
    "title" IS NULL OR (
        "rawPurgedAt" IS NULL AND "rawCiphertext" IS NOT NULL AND
        char_length("title") >= 1
    )
  );
