-- Production 2026-11-24: a signed-in account could not send a question longer
-- than 50,000 characters or carrying more than 5 files. Every send saves the
-- composer draft first, and this table still held the limits the app had when
-- it was created (20260913100000), so the save failed with check_violation.
-- The app now allows CHAT_MAX_MESSAGE_CHARACTERS (five characters a token of
-- the largest context window: 5,250,000 today) and
-- CHAT_MAX_ATTACHMENTS_PER_MESSAGE (10 since #4068).
-- Bounds: text 10485760 = the 10 MiB proxy body buffer that holds CHAT_MAX_MESSAGE_BODY_BYTES (8.26 MiB, tests/chatRequestLimits.test.mjs), and a character costs at least one body byte; references 100 = ten times the app count.
-- tests/chatComposerDraftDbLimits.test.mjs fails when an app limit passes
-- either bound. Only the two bounds change; no row is updated or deleted.
ALTER TABLE "ChatComposerDraft"
  DROP CONSTRAINT "ChatComposerDraft_text_length_check",
  ADD CONSTRAINT "ChatComposerDraft_text_length_check"
    CHECK (char_length("text") <= 10485760),
  DROP CONSTRAINT "ChatComposerDraft_attachment_references_check",
  ADD CONSTRAINT "ChatComposerDraft_attachment_references_check"
    CHECK (
      jsonb_typeof("attachmentReferences") = 'array' AND
      jsonb_array_length("attachmentReferences") <= 100
    );
