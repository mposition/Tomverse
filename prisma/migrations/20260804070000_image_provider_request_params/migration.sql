-- Snapshots the parameters an attempt actually sent to its provider.
--
-- Additive and nullable, and not back-filled: what an older row sent cannot be
-- recovered, and writing a reconstruction would put a guess where an audit
-- record belongs. NULL means "not captured", which is the truth for every
-- attempt made before this column existed.
--
-- The prompt is not stored here. It already lives on the same row, and a
-- second copy inside a JSON blob is a second place every deletion path would
-- have to reach.
ALTER TABLE "ImageGeneration"
  ADD COLUMN "providerRequestParams" JSONB;
