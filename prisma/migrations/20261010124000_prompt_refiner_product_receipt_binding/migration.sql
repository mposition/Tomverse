-- baseline-check: present-if-function "guard_prompt_refiner_product_execution_receipt_insert"
-- Receipts intentionally have no lifetime foreign keys to account-scoped
-- attempts or suggestions: those rows are deleted with an authorised account
-- or conversation deletion while the content-free audit fact remains. Bind the
-- immutable fact at INSERT time instead, under row locks that close the delete
-- and cross-request races.
CREATE FUNCTION "guard_prompt_refiner_product_execution_receipt_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  attempt_row "PromptRefinerProductAttempt";
  suggestion_row "PromptRefinerChatSuggestion";
BEGIN
  SELECT * INTO attempt_row
  FROM "PromptRefinerProductAttempt"
  WHERE "id" = NEW."requestId"
  FOR SHARE;

  IF attempt_row."id" IS NULL THEN
    RAISE EXCEPTION 'prompt_refiner_product_execution_receipt_binding_invalid';
  END IF;

  IF NEW."suggestionId" IS NULL THEN
    IF attempt_row."state" NOT IN ('terminal', 'unknown') OR
       attempt_row."suggestionId" IS NOT NULL THEN
      RAISE EXCEPTION 'prompt_refiner_product_execution_receipt_binding_invalid';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO suggestion_row
  FROM "PromptRefinerChatSuggestion"
  WHERE "id" = NEW."suggestionId"
  FOR SHARE;

  IF attempt_row."state" <> 'preparing' OR
     attempt_row."suggestionId" IS NOT NULL OR
     suggestion_row."id" IS NULL OR
     suggestion_row."requestId" IS DISTINCT FROM attempt_row."id" OR
     suggestion_row."userId" IS DISTINCT FROM attempt_row."userId" OR
     suggestion_row."conversationId" IS DISTINCT FROM attempt_row."conversationId" OR
     suggestion_row."scopeId" IS DISTINCT FROM attempt_row."scopeId" OR
     suggestion_row."scopeEpoch" IS DISTINCT FROM attempt_row."scopeEpoch" OR
     suggestion_row."draftId" IS DISTINCT FROM attempt_row."draftId" OR
     suggestion_row."draftRevision" IS DISTINCT FROM attempt_row."draftRevision" OR
     suggestion_row."mode" IS DISTINCT FROM attempt_row."mode" OR
     suggestion_row."state" IS DISTINCT FROM 'ready' OR
     suggestion_row."refinerVersion" IS DISTINCT FROM NEW."refinerVersion" THEN
    RAISE EXCEPTION 'prompt_refiner_product_execution_receipt_binding_invalid';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "PromptRefinerProductExecutionReceipt_binding"
  BEFORE INSERT ON "PromptRefinerProductExecutionReceipt"
  FOR EACH ROW EXECUTE FUNCTION
    "guard_prompt_refiner_product_execution_receipt_insert"();
