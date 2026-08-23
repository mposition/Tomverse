-- Expand: Conversation.productKey, nullable, no default, plus three NOT VALID
-- CHECKs.
--
-- Contract: product boundary decision record v1.2, decision 2.
-- Application copy of the allowlist: lib/conversationProduct.ts.
--
-- Step 1 of the expand-and-contract sequence in the delivery plan §5:
--
--   1. expand      this migration -- nullable column, constraints NOT VALID;
--   2. dual-write  every writer names a productKey (the shared creation
--                  service);
--   3. dual-read   NULL reads as `review`, with an expiry;
--   4. backfill    the classified rows, gated on zero unclassified;
--   5. verify      NULL = 0 across two consecutive runs, writer coverage;
--   6. strict      PRODUCT_KEY_READ_MODE flips, with a rollback rehearsal;
--   7. enforce     VALIDATE CONSTRAINT and NOT NULL, each with its own
--                  evidence.
--
-- Steps 6 and 7 are NOT in this migration and must not be added to it.
--
-- ## Why nullable and why no default
--
-- 20260814170000_attempt_cost_accrual already wrote the rule down:
--
--     The default goes with the NOT NULL. A column that is nullable but
--     defaults to 0 would answer "unknown" with "zero" for every writer that
--     omits it, which is the exact substitution the nullability exists to
--     prevent.
--
-- A `review` default here would make a writer that forgot the column
-- indistinguishable from one that meant Review, and the backfill's work list
-- would be empty for the wrong reason. During the transition NULL means "not
-- decided yet".
--
-- ## Why productKey is not kind
--
-- Delivery plan §5: "Do not reuse Conversation.kind as product identity."
-- `kind` is a server authorization boundary -- lib/conversationKindGuard.ts
-- refuses an image conversation at the chat, comparison, share, export and
-- title endpoints, and refuses a chat conversation at the image ones. The two
-- axes are orthogonal: `kind` is the modality a turn executes in, `productKey`
-- is the product task the user is performing. A Chat conversation whose user
-- picked their own model is still Chat, so selectionMode cannot stand in for
-- either.
--
-- ## Why `code` is not in the allowlist
--
-- The brand axis has four products; this column admits three. Tomverse Code
-- does not write Conversation rows yet, so admitting `code` today would make a
-- row with no execution surface a legal value -- a conversation nothing can
-- open, stored as though it were fine. It joins the allowlist when Code starts
-- writing conversations.
--
-- ## Why NOT VALID
--
-- Same reason as 20260812070000_credit_lot_non_negative: Postgres enforces a
-- NOT VALID CHECK on every INSERT and UPDATE from this point on -- which is
-- the coverage that matters, because the rows at risk are the ones not yet
-- written -- while skipping the full-table scan that would take an ACCESS
-- EXCLUSIVE lock and could fail the deploy on historical data nobody has
-- surveyed.
--
-- VALIDATE CONSTRAINT is a separate migration, after the backfill report reads
-- zero. Do NOT validate by hand in production in between:
-- scripts/compare-schema-to-migrations.mjs compares pg_get_constraintdef(),
-- whose output carries the NOT VALID suffix, so a hand-validated production
-- reads as schema drift for as long as the follow-up migration is missing.
--
-- ## What these constraints deliberately do NOT do
--
-- All three pass `productKey IS NULL`, because the transition requires it.
-- That means a writer that forgets the column writes a row every constraint
-- accepts, stored as NULL. **The constraints stop wrong combinations; they do
-- not stop omissions.** Omissions are stopped by the shared creation service,
-- the static check against direct conversation.create calls, and the writer
-- coverage tests -- all of which stay necessary after this migration lands.

ALTER TABLE "Conversation"
    ADD COLUMN "productKey" TEXT;

-- (1) The allowlist. `code` is absent on purpose; see above.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_product_key_check"
    CHECK (
        "productKey" IS NULL
        OR "productKey" IN ('chat', 'review', 'studio')
    )
    NOT VALID;

-- (2) Product and modality agree.
--
-- Two independent columns, so without this a `studio` conversation with
-- kind = 'chat' -- an image product row nothing in the image pipeline would
-- ever open -- passes silently. Image generation is Studio; Chat and Review
-- both run in the chat modality.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_product_modality_check"
    CHECK (
        "productKey" IS NULL
        OR ("kind" = 'image' AND "productKey" = 'studio')
        OR ("kind" = 'chat' AND "productKey" IN ('chat', 'review'))
    )
    NOT VALID;

-- (3) Auto is Chat-only.
--
-- Written as one allowed product rather than a list of forbidden ones. v1.1 of
-- the decision record forbade `review + auto` and left `studio + auto`
-- passing; a rule shaped as "which product may" does not grow a hole every
-- time a product is added.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_auto_only_chat_check"
    CHECK (
        "productKey" IS NULL
        OR "selectionMode" <> 'auto'
        OR "productKey" = 'chat'
    )
    NOT VALID;
