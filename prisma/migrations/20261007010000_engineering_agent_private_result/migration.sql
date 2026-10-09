-- A successful v22 Task may have a private result without a publishable patch
-- or a T2 owner draft. Keep the immutable run's outcome honest.
ALTER TABLE "EngineeringAgentRun"
    DROP CONSTRAINT "EngineeringAgentRun_outcome_check",
    ADD CONSTRAINT "EngineeringAgentRun_outcome_check"
        CHECK ("outcome" IS NULL OR "outcome" IN (
            't1_queued', 't2_draft', 'private_result', 'no_change',
            'agent_failed', 'schema_invalid', 'scope_violation',
            'secret_detected', 'abandoned'
        )) NOT VALID;
