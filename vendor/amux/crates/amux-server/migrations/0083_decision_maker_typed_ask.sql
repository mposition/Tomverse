-- The local AMUX half of the Decision Maker's typed ask (stage S2-1).
--
-- docs/policy/amux-decision-maker.md §12 names the local AMUX part of stage
-- S2: the typed ask's options, effect classes, paths, context paths and
-- `resolution`; a DM-pending marker set by one compare-and-swap and released
-- whatever the result was; and an answer record keyed by (card id, question
-- revision). Five Rust-owned tables, and three triggers on `issues` that only
-- count: the Python server keeps opening this file, and no card row is ever
-- changed by anything here.
--
-- WHAT IS IRREVERSIBLE. Migrations are additive only, so these tables and
-- triggers stay once applied. And the answer record decides which single
-- answer a worker receives for a question revision; a delivered answer cannot
-- be taken back (docs/policy/amux-decision-maker.md §2).

-- Two counters per card, kept by the database for EVERY writer: the status
-- epoch moves on each status change, the ask epoch on each change of the base
-- ask (type, question, unblocks). Both also move when a row is inserted, which
-- covers a writer that replaces a row instead of updating it. A question
-- revision and a typed-ask draft are bound to these numbers, never to a clock
-- or to the wording: a door that records no revision and moves a card
-- needsyou -> doing -> needsyou inside one second, or rewords a question and
-- puts the old wording back, still moves an epoch, so the old revision and the
-- old draft stop applying (review r-20261016-230112-9bf37c). A card with no
-- row is at epoch 0 for both.
--
-- The triggers can only count. They have no CHECK to violate and the row is
-- created before it is incremented, so they cannot fail a card write. The row
-- is created with WHERE NOT EXISTS and no conflict clause on purpose: SQLite
-- lets the firing statement's conflict policy override the one inside a
-- trigger, so an `INSERT OR IGNORE` here becomes `INSERT OR REPLACE` under an
-- outer `INSERT OR REPLACE INTO issues` and resets the counters, which could
-- bring an old revision's epochs back. A statement that cannot conflict has
-- no policy to override.
CREATE TABLE IF NOT EXISTS _amux_dm_card_epochs (
    issue_id      TEXT PRIMARY KEY,
    status_epoch  INTEGER NOT NULL DEFAULT 0,
    ask_epoch     INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS amux_dm_epochs_on_insert
AFTER INSERT ON issues
BEGIN
    INSERT INTO _amux_dm_card_epochs (issue_id)
        SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM _amux_dm_card_epochs WHERE issue_id = NEW.id);
    UPDATE _amux_dm_card_epochs
       SET status_epoch = status_epoch + 1, ask_epoch = ask_epoch + 1
     WHERE issue_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS amux_dm_status_epoch
AFTER UPDATE OF status ON issues
WHEN NEW.status IS NOT OLD.status
BEGIN
    INSERT INTO _amux_dm_card_epochs (issue_id)
        SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM _amux_dm_card_epochs WHERE issue_id = NEW.id);
    UPDATE _amux_dm_card_epochs SET status_epoch = status_epoch + 1 WHERE issue_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS amux_dm_ask_epoch
AFTER UPDATE OF ask_type, ask_question, ask_unblocks ON issues
WHEN NEW.ask_type IS NOT OLD.ask_type
  OR NEW.ask_question IS NOT OLD.ask_question
  OR NEW.ask_unblocks IS NOT OLD.ask_unblocks
BEGIN
    INSERT INTO _amux_dm_card_epochs (issue_id)
        SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM _amux_dm_card_epochs WHERE issue_id = NEW.id);
    UPDATE _amux_dm_card_epochs SET ask_epoch = ask_epoch + 1 WHERE issue_id = NEW.id;
END;

-- The typed-ask extension a worker last wrote for a card, beside the base ask
-- it was written with and the ask epoch at that moment. A draft, not a fact:
-- it is rewritten on every write that carries `typed_ask`, and it only applies
-- while the card is still at that ask epoch, so neither a re-asked question
-- nor one reworded back to an earlier wording inherits these options.
CREATE TABLE IF NOT EXISTS _amux_dm_typed_asks (
    issue_id      TEXT PRIMARY KEY,
    ask_epoch     INTEGER NOT NULL,
    ask_type      TEXT,
    ask_question  TEXT,
    ask_unblocks  TEXT,
    detail        TEXT NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- One row per question revision: the base ask and the extension as they stood
-- when the card was asking that question, and the two epochs it was asked
-- under. Immutable, because the app binds a Decision Maker request to
-- (card id, question revision) and a revision whose content could change
-- afterwards would make that binding mean nothing. A revision is current only
-- while the card is at both of its epochs.
CREATE TABLE IF NOT EXISTS _amux_dm_ask_revisions (
    issue_id          TEXT NOT NULL,
    question_revision INTEGER NOT NULL
        CHECK (question_revision BETWEEN 1 AND 2147483647),
    status_epoch      INTEGER NOT NULL,
    ask_epoch         INTEGER NOT NULL,
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
