-- Whether pressing the chat image handoff generates straight away.
--
-- An account setting rather than a browser one because it decides whether one
-- click spends credits: a preference stored per device would let a shared
-- computer spend somebody else's. See
-- docs/ui-contracts/image-generation-workspace.md.
--
-- NOT NULL with a default rather than nullable: there is no third state here.
-- An account has either chosen to stop being asked or it has not, and every
-- existing row has not. Adding a NOT NULL column with a constant default is a
-- metadata-only change in PostgreSQL 11 and later, so no row is rewritten and
-- the table is not held.
ALTER TABLE "UserSettings"
  ADD COLUMN IF NOT EXISTS "imageHandoffAutoGenerate" BOOLEAN NOT NULL DEFAULT false;
