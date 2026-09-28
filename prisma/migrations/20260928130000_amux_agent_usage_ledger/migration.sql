-- The AMUX cost ledger records an adapter agent's own model spend at
-- settlement (docs/policy/development-agent-orchestration.md, Authority,
-- version 12: "settle 때 그 Agent의 LLM 사용액을 AMUX 비용 원장에 AMUX writer로
-- 기록한다 ... admission 합계에 넣지 않는다"). The operator chose a scope of its
-- own on 2026-09-28: an agent card rarely has a project or team budget, and a
-- row charged to one would sit where admission sums.
--
-- `agent` / `agent_usage` rows name the agent as their resource and the UTC
-- month as their window. Admission, the Admin resources screen and the
-- staging evidence read the ledger by a policy's own project or team scope and
-- key, so these rows reach none of them. Nothing here writes a row.

BEGIN;

ALTER TABLE "AmuxCostLedgerEntry" DROP CONSTRAINT "AmuxCostLedgerEntry_scope_check";
ALTER TABLE "AmuxCostLedgerEntry" DROP CONSTRAINT "AmuxCostLedgerEntry_kind_check";
ALTER TABLE "AmuxCostLedgerEntry" DROP CONSTRAINT "AmuxCostLedgerEntry_amount_check";

ALTER TABLE "AmuxCostLedgerEntry"
    ADD CONSTRAINT "AmuxCostLedgerEntry_scope_check"
        CHECK ("scope" IN ('project', 'team', 'agent')) NOT VALID,
    ADD CONSTRAINT "AmuxCostLedgerEntry_kind_check"
        CHECK ("kind" IN ('reservation', 'settlement_delta', 'agent_usage')) NOT VALID,
    ADD CONSTRAINT "AmuxCostLedgerEntry_amount_check"
        CHECK (
            ("kind" = 'reservation' AND "amountMicrousd" >= 0)
            OR "kind" = 'settlement_delta'
            OR ("kind" = 'agent_usage' AND "amountMicrousd" >= 0)
        ) NOT VALID,
    -- An agent's usage is charged to its own scope and never to a budget
    -- admission reads; a budget's rows never take the agent scope.
    ADD CONSTRAINT "AmuxCostLedgerEntry_agent_scope_check"
        CHECK (("kind" = 'agent_usage') = ("scope" = 'agent')) NOT VALID;

ALTER TABLE "AmuxCostLedgerEntry" VALIDATE CONSTRAINT "AmuxCostLedgerEntry_scope_check";
ALTER TABLE "AmuxCostLedgerEntry" VALIDATE CONSTRAINT "AmuxCostLedgerEntry_kind_check";
ALTER TABLE "AmuxCostLedgerEntry" VALIDATE CONSTRAINT "AmuxCostLedgerEntry_amount_check";
ALTER TABLE "AmuxCostLedgerEntry" VALIDATE CONSTRAINT "AmuxCostLedgerEntry_agent_scope_check";

COMMIT;
