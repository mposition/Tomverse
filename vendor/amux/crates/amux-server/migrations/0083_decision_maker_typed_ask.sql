-- The local AMUX half of the Decision Maker's typed ask (stage S2-1).
--
-- docs/policy/amux-decision-maker.md §12 names the local AMUX part of stage
-- S2: the typed ask's options, effect classes, paths, context paths and
-- `resolution`; a DM-pending marker set by one compare-and-swap and released
-- whatever the result was; and an answer record keyed by (card id, question
-- revision). Four tables, all Rust-owned, none touching `issues`: the Python
-- server keeps opening this file, and a card row it writes is never changed by
-- anything here.
--
-- WHAT IS IRREVERSIBLE. Migrations are additive only, so these tables and
-- triggers stay once applied. And the answer record decides which single
-- answer a worker receives for a question revision; a delivered answer cannot
-- be taken back (docs/policy/amux-decision-maker.md §2).

-- The typed-ask extension a worker last wrote for a card, beside the base ask
-- it was written with. A draft, not a fact: it is rewritten on every write
-- that carries `typed_ask`, and it only applies to a question while the card's
-- base ask (type, question, unblocks) still equals the copy kept here, so a
-- re-asked question never inherits the previous question's options.
CREATE TABLE IF NOT EXISTS _amux_dm_typed_asks (
    issue_id      TEXT PRIMARY KEY,
    ask_type      TEXT,
    ask_question  TEXT,
    ask_unblocks  TEXT,
    detail        TEXT NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- One row per question revision: the base ask and the extension as they stood
-- when the card was asking that question. Immutable, because the app binds a
-- Decision Maker request to (card id, question revision) and a revision whose
-- content could change afterwards would make that binding mean nothing.
CREATE TABLE IF NOT EXISTS _amux_dm_ask_revisions (
    issue_id          TEXT NOT NULL,
    question_revision INTEGER NOT NULL
        CHECK (question_revision BETWEEN 1 AND 2147483647),
    entered_state_at  INTEGER,
    ask_type          TEXT,
    ask_question      TEXT,
    ask_unblocks      TEXT,
    detail            TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    PRIMARY KEY (issue_id, question_revision)
);

CREATE TRIGGER IF NOT EXISTS amux_dm_ask_revisions_no_update
BEFORE UPDATE ON _amux_dm_ask_revisions
BEGIN SELECT RAISE(ABORT, 'decision maker question revisions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS amux_dm_ask_revisions_no_delete
BEFORE DELETE ON _amux_dm_ask_revisions
BEGIN SELECT RAISE(ABORT, 'decision maker question revisions are immutable'); END;

-- "A Decision Maker is drafting a proposal for this question." Informational:
-- the card keeps its status and the operator can answer at any time. Set only
-- by a compare-and-swap against the card's current question revision, and
-- removed by the request that set it whatever the result was.
CREATE TABLE IF NOT EXISTS _amux_dm_pending (
    issue_id          TEXT NOT NULL,
    question_revision INTEGER NOT NULL,
    request_id        TEXT NOT NULL,
    instance          TEXT NOT NULL
        CHECK (instance IN ('decision-maker-openai', 'decision-maker-anthropic')),
    set_at            INTEGER NOT NULL,
    PRIMARY KEY (issue_id, question_revision)
);

-- The answer record. Whoever writes the row for (card id, question revision)
-- first is the one answer delivered; the operator's direct answer and an
-- operator-confirmed Decision Maker answer both have to write it before
-- sending, and the second is refused. There is no source for an unconfirmed
-- Decision Maker output: version 1 is proposal-only.
CREATE TABLE IF NOT EXISTS _amux_dm_answers (
    issue_id          TEXT NOT NULL,
    question_revision INTEGER NOT NULL,
    source            TEXT NOT NULL
        CHECK (source IN ('operator', 'dm_confirmed')),
    request_id        TEXT,
    actor             TEXT NOT NULL,
    recorded_at       INTEGER NOT NULL,
    PRIMARY KEY (issue_id, question_revision),
    CHECK ((source = 'dm_confirmed') = (request_id IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS amux_dm_answers_no_update
BEFORE UPDATE ON _amux_dm_answers
BEGIN SELECT RAISE(ABORT, 'decision maker answer records are immutable'); END;

CREATE TRIGGER IF NOT EXISTS amux_dm_answers_no_delete
BEFORE DELETE ON _amux_dm_answers
BEGIN SELECT RAISE(ABORT, 'decision maker answer records are immutable'); END;
