-- AMUX v4 analysis cost is agent-only. A writer cannot make the monthly
-- spent-plus-reserved total exceed the owner-approved USD 50 ceiling.
ALTER TABLE "AmuxIdeaAnalysisBudgetWindow"
  ADD CONSTRAINT "AmuxIdeaAnalysisBudgetWindow_total_check"
  CHECK ("spentMicroUsd" <= "limitMicroUsd" - "reservedMicroUsd");
