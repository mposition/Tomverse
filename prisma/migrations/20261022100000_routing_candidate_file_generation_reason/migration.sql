-- C13 narrows identified file requests to file-capable eligible models.
-- Keep the existing verdict contract and allow its new content-free reason.
-- One ALTER statement replaces the constraint atomically; no rows are changed.
ALTER TABLE "RoutingCandidateVerdict"
    DROP CONSTRAINT "RoutingCandidateVerdict_reason_check",
    ADD CONSTRAINT "RoutingCandidateVerdict_reason_check"
    CHECK (
        "reason" IS NULL
        OR "reason" IN (
            'disabled',
            'plan',
            'image_input_unsupported',
            'web_search_unsupported',
            'web_search_unverified',
            'web_search_cost_unbounded',
            'context_window_undeclared',
            'context_exceeded',
            'unhealthy',
            'region_unavailable',
            'insufficient_credits',
            'file_generation_unsupported'
        )
    );
