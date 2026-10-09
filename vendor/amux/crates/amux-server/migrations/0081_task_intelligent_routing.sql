-- Intelligent task-routing persistence.
--
-- `issues` remains the source of truth for lifecycle, assignment, dependencies,
-- reviewer, criteria and verification. These tables store only classification,
-- explainable routing decisions and per-attempt economic/attention metrics.
--
-- Routing history intentionally has no FK to `issues`: audit history should
-- survive card archival/deletion and historical imports.

CREATE TABLE task_classification (
    task_id              TEXT PRIMARY KEY,
    task_kind            TEXT NOT NULL CHECK (
        task_kind IN (
            'architecture',
            'reasoning',
            'feature',
            'bugfix',
            'iteration',
            'refactor',
            'migration',
            'dependency_upgrade',
            'tests',
            'review',
            'security',
            'integration'
        )
    ),
    complexity           INTEGER NOT NULL CHECK (complexity BETWEEN 1 AND 10),
    risk                 INTEGER NOT NULL CHECK (risk BETWEEN 1 AND 3),
    files_expected_json  TEXT,
    classified_by        TEXT NOT NULL,
    classifier_version   TEXT NOT NULL,
    classified_at        INTEGER NOT NULL
);

CREATE TABLE task_route_decisions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id               TEXT NOT NULL,
    phase                 TEXT NOT NULL CHECK (
        phase IN ('execute', 'review', 'integration')
    ),
    attempt               INTEGER,
    preferred_worker      TEXT,
    selected_worker       TEXT,
    routing_score         REAL,
    score_breakdown_json  TEXT,
    routing_reason        TEXT NOT NULL,
    quota_snapshot_json   TEXT,
    created_at            INTEGER NOT NULL
);

CREATE INDEX idx_task_route_decisions_task_created
    ON task_route_decisions(task_id, created_at, id);

CREATE INDEX idx_task_route_decisions_task_phase
    ON task_route_decisions(task_id, phase, created_at, id);

CREATE TABLE task_attempt_metrics (
    task_id               TEXT NOT NULL,
    attempt               INTEGER NOT NULL,
    provider              TEXT,
    model                 TEXT,
    agent_active_ms       INTEGER CHECK (
        agent_active_ms IS NULL OR agent_active_ms >= 0
    ),
    human_attention_ms    INTEGER CHECK (
        human_attention_ms IS NULL OR human_attention_ms >= 0
    ),
    quota_before_json     TEXT,
    quota_after_json      TEXT,
    files_changed         INTEGER CHECK (
        files_changed IS NULL OR files_changed >= 0
    ),
    tests_added           INTEGER CHECK (
        tests_added IS NULL OR tests_added >= 0
    ),
    human_interventions   INTEGER NOT NULL DEFAULT 0 CHECK (
        human_interventions >= 0
    ),
    first_pass            INTEGER CHECK (
        first_pass IS NULL OR first_pass IN (0, 1)
    ),
    review_result         TEXT,
    PRIMARY KEY (task_id, attempt)
);
