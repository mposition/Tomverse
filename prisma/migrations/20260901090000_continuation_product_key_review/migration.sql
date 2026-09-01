-- Corrects the product recorded on conversations continued from an imported
-- external conversation.
--
-- Contract: docs/policy/external-conversation-continuation.md 15,
-- docs/policy/conversation-product-key.md 5.3.1.
--
-- Continuing an imported transcript is asking several models the same next
-- question with the same imported context. That is Review. The first release
-- of the feature defined it as single-model Chat and wrote 'chat' into the
-- column; the policy and the writer both now say 'review', and these rows are
-- the ones already stored under the old definition.
--
-- ## What decides a row is in scope
--
-- Two facts, and only these two:
--
--   1. it has a ConversationContinuationBridge -- the only thing that says a
--      conversation was started from an imported source. Provenance is the
--      bridge's job; the product is the column's.
--
--   2. its productKey is exactly 'chat' -- the value the old definition wrote.
--
-- NULL is deliberately NOT in scope. NULL means "not decided yet" during the
-- expand-and-contract transition (conversation-product-key policy 3), and the
-- backfill step owns that decision. A migration that quietly resolved NULL to
-- 'review' here would be making the backfill's call for a subset of rows, out
-- of order and with no report behind it.
--
-- Rows with no bridge are not touched at all: the join is what guarantees an
-- ordinary Chat conversation cannot be swept up.
--
-- ## What this does not change
--
-- One column. Not "selectedModels" -- a deployment that widened somebody's
-- model selection would multiply what every later turn costs them, without
-- their asking, and there is no history table to undo it from. Not
-- "selectionMode", "title", "kind", "disabledPanels", the bridge, or any
-- Message.
--
-- "kind" needs no change because Chat and Review share the 'chat' modality:
-- Conversation_product_modality_check passes before and after. Auto is
-- Chat-only, but continuations are created with selectionMode 'manual', so
-- Conversation_auto_only_chat_check has nothing to catch here -- and the
-- WHERE clause below asserts it rather than assuming it, so a row that
-- somehow held 'auto' is left alone for a human instead of being flipped into
-- a combination the constraint forbids.
--
-- The screen does not move either. conversationSurface() reads the bridge and
-- nothing else, so these conversations open at /continuations/[id] before and
-- after.
--
-- ## Reverse
--
--   UPDATE "Conversation" c SET "productKey" = 'chat'
--   FROM "ConversationContinuationBridge" b
--   WHERE b."conversationId" = c."id" AND c."productKey" = 'review';
--
-- Exact, because nothing else was written.

UPDATE "Conversation" AS c
SET "productKey" = 'review'
FROM "ConversationContinuationBridge" AS b
WHERE b."conversationId" = c."id"
  AND c."productKey" = 'chat'
  AND c."selectionMode" <> 'auto';
