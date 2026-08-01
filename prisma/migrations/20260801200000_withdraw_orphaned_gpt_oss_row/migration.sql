-- Withdraw the GPT-OSS runtime row that no longer has a catalogue entry.
--
-- getRuntimeModels() answers from ModelRegistryEntry, not from
-- AVAILABLE_MODELS: registryRowToModel builds an AiModel out of the row's own
-- columns and never consults the static catalogue. So deleting an entry from
-- lib/models.ts does not remove the model from an environment that has
-- already seeded it -- the row keeps serving.
--
-- Both replay paths need a static entry to work from and therefore cannot
-- reach this row:
--
--   * reconcileStaticWithdrawals iterates STATIC_WITHDRAWN_MODELS, and
--   * applyScopedStaticCatalogReconciliation filters seed rows by id.
--
-- With no entry to iterate, an id removed outright is invisible to both. That
-- is the one shape the withdrawal replay does not cover, and groq-gpt-oss-120b
-- is in it: release #225 shipped it enabled and publicly listed, #180 then
-- removed the entry rather than retiring it, so without this the model stays
-- selectable in every already-seeded environment while existing nowhere in the
-- catalogue.
--
-- Withdrawn rather than catalogDeleted: the id has to keep resolving for the
-- conversations, ledger rows and user settings that already reference it, and
-- catalogDeleted is an operator decision this must not make on their behalf.
-- The replacement matches what llama-3-3 -- the Free/advanced model GPT-OSS
-- was introduced to replace -- points at, so the two hand off to the same
-- place.
--
-- Guarded on the row still being offerable, so an operator who has already
-- withdrawn it by hand keeps their own reason and note. Idempotent: a second
-- run matches nothing.
UPDATE "ModelRegistryEntry"
SET
  "enabled" = false,
  "publiclyListed" = false,
  "status" = 'disabled',
  "replacementModelId" = 'mistral-medium-3-1',
  "operationalReason" = 'Tomverse does not list GPT-OSS: it is an open-weight line, not OpenAI hosted GPT. Removed from the catalogue on 2026-08-01.',
  "userVisibleNote" = 'This model is no longer offered. Please select Mistral Medium 3.5 or another current model.'
WHERE
  "id" = 'groq-gpt-oss-120b'
  AND (
    "enabled" = true
    OR "publiclyListed" = true
    OR "status" <> 'disabled'
  );
