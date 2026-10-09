-- Classification confidence and provenance.
--
-- Keep classification output separate from the board lifecycle.  The trace is
-- JSON so new classifier tiers/models/signals do not require schema changes.

ALTER TABLE task_classification
    ADD COLUMN confidence REAL NOT NULL DEFAULT 0.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0);

ALTER TABLE task_classification
    ADD COLUMN classification_method TEXT NOT NULL DEFAULT 'unknown'
    CHECK (
        classification_method IN (
            'unknown',
            'rules',
            'model',
            'hybrid',
            'premium_adjudication'
        )
    );

ALTER TABLE task_classification
    ADD COLUMN classification_trace_json TEXT;
