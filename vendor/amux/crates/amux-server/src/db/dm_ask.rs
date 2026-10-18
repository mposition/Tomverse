//! The local AMUX half of the Decision Maker's typed ask (stage S2-1,
//! migration 0083).
//!
//! docs/policy/amux-decision-maker.md §12 names the local AMUX part of stage
//! S2, and this module is it, as store functions on the writer's connection:
//!
//! 1. **The typed-ask extension.** Options (each with an id, a label, an
//!    effect class and the paths a change option would touch), `resolution`,
//!    free-text context and up to 64 context paths, beside the existing
//!    `ask_type`/`ask_question`/`ask_unblocks` columns, which this module never
//!    writes. A worker sends it as `typed_ask` on the same create/PATCH that
//!    carries the base ask.
//! 2. **Question revisions.** The app binds a Decision Maker request to
//!    (card id, question revision) (docs/policy/amux-decision-maker.md §9), so
//!    a revision is an immutable snapshot of what the card was asking, taken
//!    when a typed card enters `needsyou` or changes its ask while there. It
//!    is bound to two counters the database keeps for every writer (a status
//!    epoch and an ask epoch, migration 0083), never to a clock or to the
//!    wording, so any status change or rewording by any door ends it.
//! 3. **The DM-pending marker**, set by one compare-and-swap against the
//!    card's current question revision and removed by the request that set it,
//!    with no parameter for what the result was.
//! 4. **The answer record**, unique on (card id, question revision). The
//!    operator's direct answer and an operator-confirmed answer both claim it
//!    before sending, and only the first claim is delivered.
//!
//! The grammar of the extension is the app's, not a local variant: the option
//! id pattern, the closed `resolution` list, the 64-path context limit and the
//! repository path rules match `lib/amux/decisionMakerCore.ts`, and the effect
//! classes and the 1 to 50 change paths match docs/policy/amux-decision-maker.md §4.
//! A card that passes here therefore never fails the app's routing on a
//! grammar point; the app still runs every routing check of its own.
//!
//! WHAT THIS MODULE MUST NEVER GROW: a way for a Decision Maker output to reach
//! a worker without the operator. Policy version 1 is proposal-only
//! (docs/policy/amux-decision-maker.md §1). Nothing here represents a DM output
//! at all: the marker's release takes no result, and the answer record's only
//! sources are `operator` and `dm_confirmed`, the second being an answer the
//! operator confirmed in Admin. The relay that brings a confirmed answer here,
//! and who may call the marker and the record over HTTP, belong to the bridge
//! stage, which also owns the "never posts to /api/board" boundary.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::board_store::{parse_status, ASK_TYPES};
use amux_core::board::TaskStatus;

/// The layout of a stored extension. A change of layout is a new value.
pub const TYPED_ASK_FORMAT: &str = "amux-typed-ask-v1";

/// docs/policy/amux-decision-maker.md §5: at most 64 context paths.
pub const CONTEXT_PATHS_MAX: usize = 64;
/// docs/policy/amux-decision-maker.md §5: a repository path is at most 200 bytes.
pub const REPOSITORY_PATH_MAX_BYTES: usize = 200;
/// docs/policy/amux-decision-maker.md §4: a change option names 1 to 50 paths.
pub const CHANGE_PATHS_MIN: usize = 1;
pub const CHANGE_PATHS_MAX: usize = 50;
/// docs/policy/amux-decision-maker.md §5 caps a card's text at 16 KiB. The app
/// measures the whole card; this bounds the extension alone, which is the part
/// this table stores, so an extension no card could carry is refused here.
pub const TYPED_ASK_MAX_BYTES: usize = 16 * 1024;
/// The app's `DM_OPTION_ID_PATTERN` allows 32 characters.
pub const OPTION_ID_MAX_CHARS: usize = 32;

/// The app's `DM_RESOLUTIONS`, in its order.
pub const RESOLUTIONS: [&str; 4] = [
    "needs_secret",
    "needs_permission_change",
    "needs_contact",
    "decision_only",
];

/// docs/policy/amux-decision-maker.md §4, in the table's order.
pub const EFFECT_CLASSES: [&str; 6] = [
    "choice_only",
    "wait_or_defer",
    "branch_code_change",
    "docs_change",
    "test_change",
    "other",
];

/// The classes that change files on the worker's branch and so name paths.
pub const CHANGE_EFFECT_CLASSES: [&str; 3] = ["branch_code_change", "docs_change", "test_change"];

/// The effect a missing or malformed declaration is recorded as
/// (docs/policy/amux-decision-maker.md §4, the `other` row).
pub const EFFECT_OTHER: &str = "other";

/// The app's `DM_INSTANCE_SCOPES`.
pub const DM_INSTANCES: [&str; 2] = ["decision-maker-openai", "decision-maker-anthropic"];

/// The app's `DM_OPTION_ID_PATTERN`, `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`.
pub fn is_option_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= OPTION_ID_MAX_CHARS
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// The app's `repositoryPathRefusal`, check for check and in the same order:
/// the `repositoryPaths` grammar of docs/policy/amux-intake.md plus the extra
/// rules of docs/policy/amux-decision-maker.md §5. `None` means acceptable.
pub fn repository_path_refusal(path: &str) -> Option<&'static str> {
    if path.is_empty() {
        return Some("empty");
    }
    if path.len() > REPOSITORY_PATH_MAX_BYTES {
        return Some("too_long");
    }
    if path.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f) {
        return Some("control_character");
    }
    let bytes = path.as_bytes();
    if path.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Some("absolute");
    }
    if path.contains('\\') {
        return Some("backslash");
    }
    if path.contains(['%', '?', '#']) {
        return Some("url_syntax");
    }
    if path.split('/').any(str::is_empty) {
        return Some("empty_segment");
    }
    if path
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Some("dot_segment");
    }
    None
}

/// The UUID form the app gives a Decision Maker request id.
pub fn is_request_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, b)| match index {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

fn is_needsyou(status: &str) -> bool {
    parse_status(status) == Some(TaskStatus::NeedsYou)
}

/// A typed ask names one of the closed ask types. Same normalisation as the
/// needsyou gate's `ask_verdict`, so "typed" means the same thing in both.
fn is_typed(ask_type: Option<&str>) -> bool {
    ask_type.is_some_and(|t| ASK_TYPES.contains(&t.trim().to_ascii_lowercase().as_str()))
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

/// One option as recorded. `effect` is always one of [`EFFECT_CLASSES`], and
/// `paths` is non-empty exactly when `effect` is a change class.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypedAskOption {
    pub id: String,
    pub label: String,
    pub effect: String,
    pub paths: Vec<String>,
}

/// The extension as stored. Field order is the serialization order, so the
/// same extension is the same bytes on every write and two drafts compare by
/// their text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypedAsk {
    pub format: String,
    pub options: Vec<TypedAskOption>,
    pub resolution: Option<String>,
    pub context: String,
    pub context_paths: Vec<String>,
}

impl TypedAsk {
    /// What a question has when no extension applies to it.
    pub fn empty() -> Self {
        TypedAsk {
            format: TYPED_ASK_FORMAT.into(),
            options: vec![],
            resolution: None,
            context: String::new(),
            context_paths: vec![],
        }
    }

    pub fn canonical(&self) -> String {
        serde_json::to_string(self).expect("a typed ask always serializes")
    }
}

/// What a `typed_ask` key in a request body asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypedAskInput {
    /// `"typed_ask": null` removes the card's extension.
    Clear,
    Set(TypedAsk),
}

impl TypedAskInput {
    /// The extension as it was recorded, for the response: a worker whose
    /// effect declaration was recorded as `other` sees that here instead of
    /// finding out from the operator.
    pub fn recorded_json(&self) -> Value {
        match self {
            TypedAskInput::Clear => Value::Null,
            TypedAskInput::Set(ask) => {
                serde_json::to_value(ask).expect("a typed ask always serializes")
            }
        }
    }
}

/// Why a `typed_ask` value was refused. Refused before any write, so a
/// refusal never leaves half an ask behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedAskRefusal {
    pub code: &'static str,
    pub field: String,
    pub detail: String,
}

impl TypedAskRefusal {
    fn new(code: &'static str, field: impl Into<String>, detail: impl Into<String>) -> Self {
        TypedAskRefusal {
            code,
            field: field.into(),
            detail: detail.into(),
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "error": "typed_ask was refused; nothing in this request was written",
            "code": self.code,
            "field": self.field,
            "detail": self.detail,
            "policy": "docs/policy/amux-decision-maker.md",
        })
    }
}

const TYPED_ASK_KEYS: [&str; 4] = ["options", "resolution", "context", "context_paths"];
const OPTION_KEYS: [&str; 4] = ["id", "label", "effect", "paths"];

fn string_list(value: &Value, field: &str) -> Result<Vec<String>, TypedAskRefusal> {
    let Some(items) = value.as_array() else {
        return Err(TypedAskRefusal::new(
            "typed_ask_not_a_list",
            field,
            "must be a JSON array of strings",
        ));
    };
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.as_str().map(str::to_string).ok_or_else(|| {
                TypedAskRefusal::new(
                    "typed_ask_not_a_string",
                    format!("{field}[{index}]"),
                    "must be a string",
                )
            })
        })
        .collect()
}

/// The effect a declaration is recorded as, and the paths that go with it
/// (docs/policy/amux-decision-maker.md §4). A change class needs 1 to 50 paths
/// that each pass the repository path grammar, none repeated; the other
/// classes name no path. Anything else, including no declaration at all, is
/// recorded as `other` with no paths. It is recorded, never refused: §4 says a
/// missing or malformed declaration is a fact the operator and version 2 judge,
/// and a refusal would make a worker guess until its declaration looked right.
pub fn recorded_effect(declared: Option<&str>, paths: &[String]) -> (String, Vec<String>) {
    let other = (EFFECT_OTHER.to_string(), vec![]);
    let Some(effect) = declared.filter(|e| EFFECT_CLASSES.contains(e)) else {
        return other;
    };
    if CHANGE_EFFECT_CLASSES.contains(&effect) {
        let mut seen = std::collections::HashSet::new();
        let well_formed = (CHANGE_PATHS_MIN..=CHANGE_PATHS_MAX).contains(&paths.len())
            && paths
                .iter()
                .all(|p| repository_path_refusal(p).is_none() && seen.insert(p.as_str()));
        return if well_formed {
            (effect.to_string(), paths.to_vec())
        } else {
            other
        };
    }
    if paths.is_empty() {
        (effect.to_string(), vec![])
    } else {
        other
    }
}

/// Parse and check the `typed_ask` value of a request body. Every structural
/// rule refuses (an unknown key, a wrong JSON type, an option id outside the
/// app's grammar or repeated, a `resolution` outside the closed list, a bad or
/// 65th context path, an extension over 16 KiB). Effect declarations are
/// recorded, not refused; see [`recorded_effect`].
pub fn parse_typed_ask(value: &Value) -> Result<TypedAskInput, TypedAskRefusal> {
    if value.is_null() {
        return Ok(TypedAskInput::Clear);
    }
    let Some(map) = value.as_object() else {
        return Err(TypedAskRefusal::new(
            "typed_ask_not_an_object",
            "typed_ask",
            "must be a JSON object or null",
        ));
    };
    if let Some(unknown) = map.keys().find(|k| !TYPED_ASK_KEYS.contains(&k.as_str())) {
        return Err(TypedAskRefusal::new(
            "typed_ask_unknown_field",
            format!("typed_ask.{unknown}"),
            format!("allowed keys are {}", TYPED_ASK_KEYS.join(", ")),
        ));
    }

    let mut options = Vec::new();
    if let Some(raw) = map.get("options").filter(|v| !v.is_null()) {
        let Some(items) = raw.as_array() else {
            return Err(TypedAskRefusal::new(
                "typed_ask_not_a_list",
                "typed_ask.options",
                "must be a JSON array",
            ));
        };
        let mut ids = std::collections::HashSet::new();
        for (index, item) in items.iter().enumerate() {
            let field = format!("typed_ask.options[{index}]");
            let Some(option) = item.as_object() else {
                return Err(TypedAskRefusal::new(
                    "typed_ask_not_an_object",
                    field,
                    "an option must be a JSON object",
                ));
            };
            if let Some(unknown) = option.keys().find(|k| !OPTION_KEYS.contains(&k.as_str())) {
                return Err(TypedAskRefusal::new(
                    "typed_ask_unknown_field",
                    format!("{field}.{unknown}"),
                    format!("allowed keys are {}", OPTION_KEYS.join(", ")),
                ));
            }
            let Some(id) = option.get("id").and_then(Value::as_str) else {
                return Err(TypedAskRefusal::new(
                    "typed_ask_not_a_string",
                    format!("{field}.id"),
                    "must be a string",
                ));
            };
            if !is_option_id(id) {
                return Err(TypedAskRefusal::new(
                    "typed_ask_option_id",
                    format!("{field}.id"),
                    "letters, digits, `_` and `-`, at most 32, starting with a letter or digit",
                ));
            }
            if !ids.insert(id.to_string()) {
                return Err(TypedAskRefusal::new(
                    "typed_ask_option_id_repeated",
                    format!("{field}.id"),
                    format!("`{id}` is already an option"),
                ));
            }
            let Some(label) = option.get("label").and_then(Value::as_str) else {
                return Err(TypedAskRefusal::new(
                    "typed_ask_not_a_string",
                    format!("{field}.label"),
                    "must be a string",
                ));
            };
            let declared = match option.get("effect") {
                None | Some(Value::Null) => None,
                Some(Value::String(effect)) => Some(effect.as_str()),
                Some(_) => {
                    return Err(TypedAskRefusal::new(
                        "typed_ask_not_a_string",
                        format!("{field}.effect"),
                        "must be a string",
                    ));
                }
            };
            let paths = match option.get("paths") {
                None | Some(Value::Null) => vec![],
                Some(raw) => string_list(raw, &format!("{field}.paths"))?,
            };
            let (effect, paths) = recorded_effect(declared, &paths);
            options.push(TypedAskOption {
                id: id.to_string(),
                label: label.to_string(),
                effect,
                paths,
            });
        }
    }

    let resolution = match map.get("resolution") {
        None | Some(Value::Null) => None,
        Some(Value::String(r)) if RESOLUTIONS.contains(&r.as_str()) => Some(r.clone()),
        Some(_) => {
            return Err(TypedAskRefusal::new(
                "typed_ask_resolution",
                "typed_ask.resolution",
                format!("must be null or one of {}", RESOLUTIONS.join(", ")),
            ));
        }
    };

    let context = match map.get("context") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(c)) => c.clone(),
        Some(_) => {
            return Err(TypedAskRefusal::new(
                "typed_ask_not_a_string",
                "typed_ask.context",
                "must be a string",
            ))
        }
    };

    let context_paths = match map.get("context_paths") {
        None | Some(Value::Null) => vec![],
        Some(raw) => string_list(raw, "typed_ask.context_paths")?,
    };
    if context_paths.len() > CONTEXT_PATHS_MAX {
        return Err(TypedAskRefusal::new(
            "typed_ask_context_paths_limit",
            "typed_ask.context_paths",
            format!(
                "at most {CONTEXT_PATHS_MAX} paths, got {}",
                context_paths.len()
            ),
        ));
    }
    for (index, path) in context_paths.iter().enumerate() {
        if let Some(reason) = repository_path_refusal(path) {
            return Err(TypedAskRefusal::new(
                "typed_ask_path",
                format!("typed_ask.context_paths[{index}]"),
                reason,
            ));
        }
    }

    let ask = TypedAsk {
        format: TYPED_ASK_FORMAT.into(),
        options,
        resolution,
        context,
        context_paths,
    };
    let bytes = ask.canonical().len();
    if bytes > TYPED_ASK_MAX_BYTES {
        return Err(TypedAskRefusal::new(
            "typed_ask_too_large",
            "typed_ask",
            format!("{bytes} bytes stored, at most {TYPED_ASK_MAX_BYTES}"),
        ));
    }
    Ok(TypedAskInput::Set(ask))
}

// ---------------------------------------------------------------------------
// Drafts and question revisions
// ---------------------------------------------------------------------------

/// The card's base ask, from the row as stored, with the card's two epochs
/// (migration 0083: the status epoch moves on every status change and the ask
/// epoch on every change of the base ask, whoever writes the row).
#[derive(Debug, Clone, PartialEq, Eq)]
struct CardAsk {
    status: String,
    status_epoch: i64,
    ask_epoch: i64,
    ask_type: Option<String>,
    ask_question: Option<String>,
    ask_unblocks: Option<String>,
}

impl CardAsk {
    fn base(&self) -> (Option<&str>, Option<&str>, Option<&str>) {
        (
            self.ask_type.as_deref(),
            self.ask_question.as_deref(),
            self.ask_unblocks.as_deref(),
        )
    }
}

fn card_ask(conn: &Connection, issue_id: &str) -> rusqlite::Result<Option<CardAsk>> {
    conn.query_row(
        "SELECT i.status, COALESCE(e.status_epoch, 0), COALESCE(e.ask_epoch, 0), \
                i.ask_type, i.ask_question, i.ask_unblocks \
         FROM issues i LEFT JOIN _amux_dm_card_epochs e ON e.issue_id = i.id \
         WHERE i.id = ?1 AND i.deleted IS NULL",
        params![issue_id],
        |r| {
            Ok(CardAsk {
                status: r.get(0)?,
                status_epoch: r.get(1)?,
                ask_epoch: r.get(2)?,
                ask_type: r.get(3)?,
                ask_question: r.get(4)?,
                ask_unblocks: r.get(5)?,
            })
        },
    )
    .optional()
}

/// The extension a worker last wrote for a card, with the base ask it was
/// written beside and the ask epoch it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TypedAskDraft {
    pub ask_epoch: i64,
    pub ask_type: Option<String>,
    pub ask_question: Option<String>,
    pub ask_unblocks: Option<String>,
    pub detail: TypedAsk,
    pub updated_at: i64,
}

impl TypedAskDraft {
    /// The draft belongs to the card's question as it stands: written in this
    /// ask generation, beside this base ask. The epoch is the binding; the
    /// wording is compared too so that a draft never applies to text it was
    /// not written beside.
    fn applies_to(&self, card: &CardAsk) -> bool {
        self.ask_epoch == card.ask_epoch
            && (
                self.ask_type.as_deref(),
                self.ask_question.as_deref(),
                self.ask_unblocks.as_deref(),
            ) == card.base()
    }
}

pub fn draft_for(conn: &Connection, issue_id: &str) -> rusqlite::Result<Option<TypedAskDraft>> {
    let row: Option<(
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        i64,
    )> = conn
        .query_row(
            "SELECT ask_epoch, ask_type, ask_question, ask_unblocks, detail, updated_at \
             FROM _amux_dm_typed_asks WHERE issue_id = ?1",
            params![issue_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(
        |(ask_epoch, ask_type, ask_question, ask_unblocks, detail, updated_at)| {
            // A row this module did not write is not an extension.
            serde_json::from_str::<TypedAsk>(&detail)
                .ok()
                .filter(|d| d.format == TYPED_ASK_FORMAT && d.canonical() == detail)
                .map(|detail| TypedAskDraft {
                    ask_epoch,
                    ask_type,
                    ask_question,
                    ask_unblocks,
                    detail,
                    updated_at,
                })
        },
    ))
}

/// Would writing `input` change the stored draft? A PATCH carrying only
/// `typed_ask` otherwise reads as a no-op and never reaches the write.
///
/// `base` is the base ask (type, question, unblocks) the card will hold after
/// this write. The draft is bound to a question generation, so re-sending the
/// same extension is a change whenever it would attach it to a question it
/// does not belong to yet: a base ask this write changes, or one that has
/// moved on since the draft was written, even back to the same wording.
pub fn draft_differs(
    conn: &Connection,
    issue_id: &str,
    input: &TypedAskInput,
    base: (Option<&str>, Option<&str>, Option<&str>),
) -> rusqlite::Result<bool> {
    let stored = draft_for(conn, issue_id)?;
    Ok(match input {
        TypedAskInput::Clear => stored.is_some(),
        TypedAskInput::Set(ask) => {
            let Some(stored) = stored else {
                return Ok(true);
            };
            let Some(card) = card_ask(conn, issue_id)? else {
                return Ok(true);
            };
            stored.detail != *ask
                || !stored.applies_to(&card)
                || (
                    stored.ask_type.as_deref(),
                    stored.ask_question.as_deref(),
                    stored.ask_unblocks.as_deref(),
                ) != base
        }
    })
}

/// Store (or remove) the card's extension, beside the base ask and the ask
/// epoch the card holds NOW. Call after the card row is written, in the same
/// transaction, so the epoch already counts this write's own change.
pub fn write_draft(
    conn: &Connection,
    issue_id: &str,
    input: &TypedAskInput,
    now: i64,
) -> rusqlite::Result<()> {
    match input {
        TypedAskInput::Clear => {
            conn.execute(
                "DELETE FROM _amux_dm_typed_asks WHERE issue_id = ?1",
                params![issue_id],
            )?;
        }
        TypedAskInput::Set(ask) => {
            let Some(card) = card_ask(conn, issue_id)? else {
                return Ok(());
            };
            conn.execute(
                "INSERT INTO _amux_dm_typed_asks \
                     (issue_id, ask_epoch, ask_type, ask_question, ask_unblocks, detail, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(issue_id) DO UPDATE SET ask_epoch = excluded.ask_epoch, \
                     ask_type = excluded.ask_type, ask_question = excluded.ask_question, \
                     ask_unblocks = excluded.ask_unblocks, detail = excluded.detail, \
                     updated_at = excluded.updated_at",
                params![
                    issue_id,
                    card.ask_epoch,
                    card.ask_type,
                    card.ask_question,
                    card.ask_unblocks,
                    ask.canonical(),
                    now
                ],
            )?;
        }
    }
    Ok(())
}

/// One question revision as recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuestionRevision {
    pub issue_id: String,
    pub question_revision: i64,
    pub status_epoch: i64,
    pub ask_epoch: i64,
    pub ask_type: Option<String>,
    pub ask_question: Option<String>,
    pub ask_unblocks: Option<String>,
    pub detail: TypedAsk,
    pub created_at: i64,
}

impl QuestionRevision {
    /// Is the card still asking this revision's question? Only if no status
    /// change and no change of the base ask has happened since it was
    /// recorded, by any writer. Both epochs count every such change, so a
    /// round trip inside one second, or a question reworded back to the same
    /// text, still ends the revision.
    fn asks(&self, card: &CardAsk) -> bool {
        self.status_epoch == card.status_epoch
            && self.ask_epoch == card.ask_epoch
            && (
                self.ask_type.as_deref(),
                self.ask_question.as_deref(),
                self.ask_unblocks.as_deref(),
            ) == card.base()
    }
}

const REVISION_COLUMNS: &str =
    "question_revision, status_epoch, ask_epoch, ask_type, ask_question, ask_unblocks, detail, created_at";

fn revision_from_row(issue_id: &str, r: &rusqlite::Row<'_>) -> rusqlite::Result<QuestionRevision> {
    let detail: String = r.get(6)?;
    Ok(QuestionRevision {
        issue_id: issue_id.to_string(),
        question_revision: r.get(0)?,
        status_epoch: r.get(1)?,
        ask_epoch: r.get(2)?,
        ask_type: r.get(3)?,
        ask_question: r.get(4)?,
        ask_unblocks: r.get(5)?,
        // Only this module writes the column, so a row that does not parse is
        // a corrupt file; an empty extension keeps it from ever offering
        // options it did not record.
        detail: serde_json::from_str(&detail).unwrap_or_else(|_| TypedAsk::empty()),
        created_at: r.get(7)?,
    })
}

fn latest_revision(
    conn: &Connection,
    issue_id: &str,
) -> rusqlite::Result<Option<QuestionRevision>> {
    conn.query_row(
        &format!(
            "SELECT {REVISION_COLUMNS} FROM _amux_dm_ask_revisions \
             WHERE issue_id = ?1 ORDER BY question_revision DESC LIMIT 1"
        ),
        params![issue_id],
        |r| revision_from_row(issue_id, r),
    )
    .optional()
}

/// One recorded revision, current or not.
pub fn revision(
    conn: &Connection,
    issue_id: &str,
    question_revision: i64,
) -> rusqlite::Result<Option<QuestionRevision>> {
    conn.query_row(
        &format!(
            "SELECT {REVISION_COLUMNS} FROM _amux_dm_ask_revisions \
             WHERE issue_id = ?1 AND question_revision = ?2"
        ),
        params![issue_id, question_revision],
        |r| revision_from_row(issue_id, r),
    )
    .optional()
}

/// The extension that belongs to the card's question as it stands: the draft
/// written in this ask generation beside this base ask, otherwise none.
fn effective_detail(
    conn: &Connection,
    issue_id: &str,
    card: &CardAsk,
) -> rusqlite::Result<TypedAsk> {
    Ok(draft_for(conn, issue_id)?
        .filter(|d| d.applies_to(card))
        .map_or_else(TypedAsk::empty, |d| d.detail))
}

/// Record a question revision when the card is asking something new.
///
/// Called after a create or PATCH writes the card, in the same transaction.
/// A card gets a revision only while it is a typed ask in `needsyou`. A new
/// revision is recorded unless the latest one is still current (same status
/// epoch, same ask epoch, same base ask) and carries the same applicable
/// extension; otherwise the latest revision stands. Returns the card's current
/// revision, if any.
pub fn sync_question_revision(
    conn: &Connection,
    issue_id: &str,
    now: i64,
) -> rusqlite::Result<Option<i64>> {
    let Some(card) = card_ask(conn, issue_id)? else {
        return Ok(None);
    };
    if !is_needsyou(&card.status) || !is_typed(card.ask_type.as_deref()) {
        return Ok(None);
    }
    let detail = effective_detail(conn, issue_id, &card)?;
    let latest = latest_revision(conn, issue_id)?;
    if let Some(latest) = latest
        .as_ref()
        .filter(|r| r.asks(&card) && r.detail == detail)
    {
        return Ok(Some(latest.question_revision));
    }
    let next = latest.map_or(1, |r| r.question_revision + 1);
    conn.execute(
        "INSERT INTO _amux_dm_ask_revisions \
             (issue_id, question_revision, status_epoch, ask_epoch, ask_type, ask_question, \
              ask_unblocks, detail, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            issue_id,
            next,
            card.status_epoch,
            card.ask_epoch,
            card.ask_type,
            card.ask_question,
            card.ask_unblocks,
            detail.canonical(),
            now
        ],
    )?;
    Ok(Some(next))
}

/// The revision the card is asking right now: its latest revision, provided
/// the card is still a typed ask in `needsyou` and neither its status nor its
/// base ask has changed since (both epochs equal). A card moved or reworded by
/// a writer that records no revision therefore has none, which sends the
/// question to the operator only until a recording write gives it a new one.
pub fn current_revision(
    conn: &Connection,
    issue_id: &str,
) -> rusqlite::Result<Option<QuestionRevision>> {
    let Some(card) = card_ask(conn, issue_id)? else {
        return Ok(None);
    };
    if !is_needsyou(&card.status) || !is_typed(card.ask_type.as_deref()) {
        return Ok(None);
    }
    Ok(latest_revision(conn, issue_id)?.filter(|r| r.asks(&card)))
}

// ---------------------------------------------------------------------------
// The DM-pending marker
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pending {
    pub issue_id: String,
    pub question_revision: i64,
    pub request_id: String,
    pub instance: String,
    pub set_at: i64,
}

/// Why a marker was not set. The bridge discards the assignment and reports
/// it to the app, which closes the request (docs/policy/amux-decision-maker.md §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingDiscard {
    InvalidRequestId,
    UnknownInstance,
    CardMissing,
    NotNeedsYou,
    StaleRevision,
    Answered,
    HeldByOtherRequest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingSet {
    Set(Pending),
    /// The same request already holds the marker; nothing was written.
    AlreadySet(Pending),
    Discarded(PendingDiscard),
}

/// Releasing a marker. There is no "result" anywhere in this type or in
/// [`release_pending`]'s parameters, on purpose: whatever the Decision Maker
/// produced (a proposal, an escalation, a failed validation, a timeout),
/// the card is released the same way (docs/policy/amux-decision-maker.md §2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingRelease {
    Released(Pending),
    /// No marker for that question revision: never set, already released, or
    /// cleared because the question was answered. Releasing twice is fine.
    NotHeld,
    /// Another request holds it; it was left in place.
    HeldByOther(Pending),
}

pub fn pending_for(
    conn: &Connection,
    issue_id: &str,
    question_revision: i64,
) -> rusqlite::Result<Option<Pending>> {
    conn.query_row(
        "SELECT request_id, instance, set_at FROM _amux_dm_pending \
         WHERE issue_id = ?1 AND question_revision = ?2",
        params![issue_id, question_revision],
        |r| {
            Ok(Pending {
                issue_id: issue_id.to_string(),
                question_revision,
                request_id: r.get(0)?,
                instance: r.get(1)?,
                set_at: r.get(2)?,
            })
        },
    )
    .optional()
}

/// Every marker the table holds, on any card in any state and on any question
/// revision, oldest first, at most `limit`. The bridge relay reads this after
/// a restart: a marker its stopped process left is found wherever its card is,
/// not only on a card its board scan happens to open.
pub fn pending_markers(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<Pending>> {
    let mut statement = conn.prepare(
        "SELECT issue_id, question_revision, request_id, instance, set_at FROM _amux_dm_pending \
         ORDER BY set_at, issue_id, question_revision LIMIT ?1",
    )?;
    let rows = statement.query_map(params![limit as i64], |r| {
        Ok(Pending {
            issue_id: r.get(0)?,
            question_revision: r.get(1)?,
            request_id: r.get(2)?,
            instance: r.get(3)?,
            set_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Set the marker with one compare-and-swap: the card is in `needsyou`, its
/// current question revision is `question_revision`, nobody has answered that
/// revision, and no other request holds the marker. Runs inside the writer's
/// transaction, so nothing can change the card between the comparison and the
/// write. Never changes the card itself.
pub fn set_pending(
    conn: &Connection,
    issue_id: &str,
    question_revision: i64,
    request_id: &str,
    instance: &str,
    now: i64,
) -> rusqlite::Result<PendingSet> {
    if !is_request_id(request_id) {
        return Ok(PendingSet::Discarded(PendingDiscard::InvalidRequestId));
    }
    if !DM_INSTANCES.contains(&instance) {
        return Ok(PendingSet::Discarded(PendingDiscard::UnknownInstance));
    }
    let Some(card) = card_ask(conn, issue_id)? else {
        return Ok(PendingSet::Discarded(PendingDiscard::CardMissing));
    };
    if !is_needsyou(&card.status) {
        return Ok(PendingSet::Discarded(PendingDiscard::NotNeedsYou));
    }
    if current_revision(conn, issue_id)?.map(|r| r.question_revision) != Some(question_revision) {
        return Ok(PendingSet::Discarded(PendingDiscard::StaleRevision));
    }
    if answer_for(conn, issue_id, question_revision)?.is_some() {
        return Ok(PendingSet::Discarded(PendingDiscard::Answered));
    }
    if let Some(held) = pending_for(conn, issue_id, question_revision)? {
        return Ok(
            if held.request_id == request_id && held.instance == instance {
                PendingSet::AlreadySet(held)
            } else {
                PendingSet::Discarded(PendingDiscard::HeldByOtherRequest)
            },
        );
    }
    conn.execute(
        "INSERT INTO _amux_dm_pending (issue_id, question_revision, request_id, instance, set_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![issue_id, question_revision, request_id, instance, now],
    )?;
    Ok(PendingSet::Set(Pending {
        issue_id: issue_id.to_string(),
        question_revision,
        request_id: request_id.to_string(),
        instance: instance.to_string(),
        set_at: now,
    }))
}

/// Remove the marker the request set. Compares the request id and nothing
/// else: not the card's status, not its revision, and not what the Decision
/// Maker produced, so every outcome leaves the card exactly as the marker
/// found it.
pub fn release_pending(
    conn: &Connection,
    issue_id: &str,
    question_revision: i64,
    request_id: &str,
) -> rusqlite::Result<PendingRelease> {
    let Some(held) = pending_for(conn, issue_id, question_revision)? else {
        return Ok(PendingRelease::NotHeld);
    };
    if held.request_id != request_id {
        return Ok(PendingRelease::HeldByOther(held));
    }
    conn.execute(
        "DELETE FROM _amux_dm_pending WHERE issue_id = ?1 AND question_revision = ?2 AND request_id = ?3",
        params![issue_id, question_revision, request_id],
    )?;
    Ok(PendingRelease::Released(held))
}

// ---------------------------------------------------------------------------
// The answer record
// ---------------------------------------------------------------------------

/// Who is answering. There is no variant for a Decision Maker output the
/// operator has not confirmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnswerSource {
    /// The operator answering directly, through the existing answer path.
    Operator,
    /// An answer the operator confirmed (as proposed or edited) in Admin,
    /// relayed by the bridge. `request_id` is the app's Decision Maker request.
    DmConfirmed { request_id: String },
}

impl AnswerSource {
    fn column(&self) -> &'static str {
        match self {
            AnswerSource::Operator => "operator",
            AnswerSource::DmConfirmed { .. } => "dm_confirmed",
        }
    }

    fn request_id(&self) -> Option<&str> {
        match self {
            AnswerSource::Operator => None,
            AnswerSource::DmConfirmed { request_id } => Some(request_id.as_str()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AnswerRecord {
    pub issue_id: String,
    pub question_revision: i64,
    pub source: String,
    pub request_id: Option<String>,
    pub actor: String,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerRefusal {
    InvalidRequestId,
    MissingActor,
    CardMissing,
    NotNeedsYou,
    StaleRevision,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnswerClaim {
    /// This answer owns the question revision; the caller may now send it.
    Claimed(AnswerRecord),
    /// Another answer got there first. Send nothing; show the operator this.
    AlreadyAnswered(AnswerRecord),
    Refused(AnswerRefusal),
}

pub fn answer_for(
    conn: &Connection,
    issue_id: &str,
    question_revision: i64,
) -> rusqlite::Result<Option<AnswerRecord>> {
    conn.query_row(
        "SELECT source, request_id, actor, recorded_at FROM _amux_dm_answers \
         WHERE issue_id = ?1 AND question_revision = ?2",
        params![issue_id, question_revision],
        |r| {
            Ok(AnswerRecord {
                issue_id: issue_id.to_string(),
                question_revision,
                source: r.get(0)?,
                request_id: r.get(1)?,
                actor: r.get(2)?,
                recorded_at: r.get(3)?,
            })
        },
    )
    .optional()
}

/// Claim the one answer of a question revision, before anything is sent.
///
/// An existing record wins over every other check: whoever asks after the
/// question was answered is told who answered it. Otherwise the card must be
/// in `needsyou` with `question_revision` as its current revision, so an answer
/// to a question the worker has since replaced is refused rather than sent.
/// A successful claim also removes that revision's DM-pending marker, since
/// nothing is pending once the question has its answer.
///
/// Runs inside the writer's transaction, and the caller sends only after it
/// commits and only on `Claimed`. A send whose outcome is unknown is never
/// retried with a second claim: the record already says it was answered
/// (docs/policy/amux-decision-maker.md §9).
pub fn claim_answer(
    conn: &Connection,
    issue_id: &str,
    question_revision: i64,
    source: &AnswerSource,
    actor: &str,
    now: i64,
) -> rusqlite::Result<AnswerClaim> {
    if source.request_id().is_some_and(|id| !is_request_id(id)) {
        return Ok(AnswerClaim::Refused(AnswerRefusal::InvalidRequestId));
    }
    let actor = actor.trim();
    if actor.is_empty() {
        return Ok(AnswerClaim::Refused(AnswerRefusal::MissingActor));
    }
    if let Some(existing) = answer_for(conn, issue_id, question_revision)? {
        return Ok(AnswerClaim::AlreadyAnswered(existing));
    }
    let Some(card) = card_ask(conn, issue_id)? else {
        return Ok(AnswerClaim::Refused(AnswerRefusal::CardMissing));
    };
    if !is_needsyou(&card.status) {
        return Ok(AnswerClaim::Refused(AnswerRefusal::NotNeedsYou));
    }
    if current_revision(conn, issue_id)?.map(|r| r.question_revision) != Some(question_revision) {
        return Ok(AnswerClaim::Refused(AnswerRefusal::StaleRevision));
    }
    let inserted = conn.execute(
        "INSERT INTO _amux_dm_answers (issue_id, question_revision, source, request_id, actor, recorded_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![issue_id, question_revision, source.column(), source.request_id(), actor, now],
    );
    match inserted {
        Ok(_) => {}
        // The writer is serialized, so the read above already saw any row;
        // the primary key is the guarantee if that ever stops being true.
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            if let Some(existing) = answer_for(conn, issue_id, question_revision)? {
                return Ok(AnswerClaim::AlreadyAnswered(existing));
            }
            return Err(rusqlite::Error::SqliteFailure(e, None));
        }
        Err(e) => return Err(e),
    }
    conn.execute(
        "DELETE FROM _amux_dm_pending WHERE issue_id = ?1 AND question_revision = ?2",
        params![issue_id, question_revision],
    )?;
    Ok(AnswerClaim::Claimed(AnswerRecord {
        issue_id: issue_id.to_string(),
        question_revision,
        source: source.column().to_string(),
        request_id: source.request_id().map(str::to_string),
        actor: actor.to_string(),
        recorded_at: now,
    }))
}

/// Stage S2-2b4: the operator's answer records after `after` -- (time in
/// seconds, card, question revision) -- in that order, at most `limit`. The
/// Tomverse bridge relay reads them to close the app's Decision Maker request
/// of each question the operator answered directly
/// (docs/policy/amux-decision-maker.md §2-7: "운영자의 직접 답이 먼저면 요청은
/// 닫힌다"). The key is the records' own values, never their row numbers,
/// which a vacuum may change, and a record's card and revision are its primary
/// key, so a read that starts strictly after the last record the reader passed
/// always moves on, however many records share a second. A read.
pub fn operator_answers_after(
    conn: &Connection,
    after: (i64, &str, i64),
    limit: usize,
) -> rusqlite::Result<Vec<AnswerRecord>> {
    let mut statement = conn.prepare(
        "SELECT issue_id, question_revision, source, request_id, actor, recorded_at \
         FROM _amux_dm_answers WHERE source = 'operator' \
         AND (recorded_at > ?1 OR (recorded_at = ?1 AND (issue_id > ?2 \
              OR (issue_id = ?2 AND question_revision > ?3)))) \
         ORDER BY recorded_at, issue_id, question_revision LIMIT ?4",
    )?;
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let (at, card, revision) = after;
    let records = statement.query_map(params![at, card, revision, limit], |r| {
        Ok(AnswerRecord {
            issue_id: r.get(0)?,
            question_revision: r.get(1)?,
            source: r.get(2)?,
            request_id: r.get(3)?,
            actor: r.get(4)?,
            recorded_at: r.get(5)?,
        })
    })?;
    records.collect()
}

/// Everything this module knows about a card, for the read endpoint.
pub fn state_json(conn: &Connection, issue_id: &str) -> rusqlite::Result<Value> {
    let draft = draft_for(conn, issue_id)?;
    let current = current_revision(conn, issue_id)?;
    let latest = latest_revision(conn, issue_id)?;
    let (pending, answer) = match current.as_ref() {
        Some(r) => (
            pending_for(conn, issue_id, r.question_revision)?,
            answer_for(conn, issue_id, r.question_revision)?,
        ),
        None => (None, None),
    };
    Ok(serde_json::json!({
        "card_id": issue_id,
        "typed_ask": draft,
        "current_revision": current,
        "latest_revision": latest.map(|r| r.question_revision),
        "pending": pending,
        "answer": answer,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const REQUEST_A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const REQUEST_B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    fn db() -> Connection {
        crate::db::migrate::test_memdb()
    }

    fn card(conn: &Connection, id: &str, status: &str, entered: i64) {
        conn.execute(
            "INSERT INTO issues (id, title, status, created, updated, entered_state_at, \
                 ask_type, ask_question, ask_unblocks, ask_actor) \
             VALUES (?1, 'a typed ask', ?2, 1000, 1000, ?3, 'decision', \
                 'Which store should the index use?', 'The owner names the store to use.', 'Ethan')",
            params![id, status, entered],
        )
        .unwrap();
    }

    fn move_to(conn: &Connection, id: &str, status: &str, entered: i64) {
        conn.execute(
            "UPDATE issues SET status = ?2, entered_state_at = ?3 WHERE id = ?1",
            params![id, status, entered],
        )
        .unwrap();
    }

    fn ask(value: Value) -> TypedAsk {
        match parse_typed_ask(&value).expect("accepted") {
            TypedAskInput::Set(ask) => ask,
            TypedAskInput::Clear => panic!("not a clear"),
        }
    }

    fn two_options() -> Value {
        json!({
            "options": [
                {"id": "sqlite", "label": "Keep SQLite", "effect": "choice_only"},
                {"id": "pg-1", "label": "Move to Postgres", "effect": "branch_code_change",
                 "paths": ["crates/amux-server/src/db/mod.rs"]}
            ],
            "resolution": null,
            "context": "The index grows by 40 MB a week.",
            "context_paths": ["docs/policy/amux-decision-maker.md"]
        })
    }

    /// Everything a card is made of, so two states can be compared whole.
    fn card_state(conn: &Connection, id: &str) -> Value {
        let issue: Value = conn
            .query_row(
                "SELECT json_object('status', status, 'desc', \"desc\", 'log', log, 'rev', rev, \
                     'version', version, 'updated', updated, 'entered_state_at', entered_state_at, \
                     'ask_type', ask_type, 'ask_question', ask_question, 'ask_unblocks', ask_unblocks, \
                     'waiting_on', waiting_on) FROM issues WHERE id = ?1",
                params![id],
                |r| r.get::<_, String>(0),
            )
            .map(|s| serde_json::from_str(&s).unwrap())
            .unwrap();
        let tags: Vec<String> = conn
            .prepare("SELECT tag FROM issue_tags WHERE issue_id = ?1 ORDER BY tag")
            .unwrap()
            .query_map(params![id], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let count = |table: &str| -> i64 {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE issue_id = ?1"),
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        json!({
            "issue": issue,
            "tags": tags,
            "revisions": count("_amux_dm_ask_revisions"),
            "drafts": count("_amux_dm_typed_asks"),
            "answers": count("_amux_dm_answers"),
            "pending": count("_amux_dm_pending"),
        })
    }

    // -- grammar: the app's, rule for rule ----------------------------------

    #[test]
    fn option_ids_follow_the_apps_pattern() {
        for good in ["a", "A1", "sqlite", "pg-1", "keep_it", &"x".repeat(32)] {
            assert!(is_option_id(good), "{good}");
        }
        for bad in [
            "",
            "-a",
            "_a",
            "a b",
            "a.b",
            "a/b",
            "é",
            &"x".repeat(33),
            "a\n",
        ] {
            assert!(!is_option_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn repository_paths_follow_the_apps_rules_in_its_order() {
        let cases: &[(&str, Option<&str>)] = &[
            ("docs/policy/amux-decision-maker.md", None),
            ("a", None),
            ("", Some("empty")),
            (&"a".repeat(201), Some("too_long")),
            ("a\u{7f}b", Some("control_character")),
            ("a\tb", Some("control_character")),
            ("/etc/passwd", Some("absolute")),
            ("C:/x", Some("absolute")),
            ("a\\b", Some("backslash")),
            ("a%2e", Some("url_syntax")),
            ("a?b", Some("url_syntax")),
            ("a#b", Some("url_syntax")),
            ("a//b", Some("empty_segment")),
            ("a/", Some("empty_segment")),
            ("./a", Some("dot_segment")),
            ("a/../b", Some("dot_segment")),
        ];
        for (path, want) in cases {
            assert_eq!(repository_path_refusal(path), *want, "{path:?}");
        }
        // 200 bytes counts bytes, not characters, as the app does.
        assert_eq!(repository_path_refusal(&"é".repeat(100)), None);
        assert_eq!(repository_path_refusal(&"é".repeat(101)), Some("too_long"));
    }

    #[test]
    fn the_closed_lists_match_the_policy() {
        assert_eq!(
            RESOLUTIONS,
            [
                "needs_secret",
                "needs_permission_change",
                "needs_contact",
                "decision_only"
            ]
        );
        assert_eq!(
            EFFECT_CLASSES,
            [
                "choice_only",
                "wait_or_defer",
                "branch_code_change",
                "docs_change",
                "test_change",
                "other"
            ]
        );
        assert_eq!(
            DM_INSTANCES,
            ["decision-maker-openai", "decision-maker-anthropic"]
        );
        assert_eq!(
            (CONTEXT_PATHS_MAX, CHANGE_PATHS_MIN, CHANGE_PATHS_MAX),
            (64, 1, 50)
        );
    }

    #[test]
    fn a_well_formed_typed_ask_is_stored_as_written() {
        let parsed = ask(two_options());
        assert_eq!(parsed.options.len(), 2);
        assert_eq!(parsed.options[1].effect, "branch_code_change");
        assert_eq!(
            parsed.options[1].paths,
            ["crates/amux-server/src/db/mod.rs"]
        );
        assert_eq!(parsed.context_paths, ["docs/policy/amux-decision-maker.md"]);
        // Canonical: the same extension is the same bytes, whatever key order
        // the request used.
        let reordered = json!({
            "context_paths": ["docs/policy/amux-decision-maker.md"],
            "context": "The index grows by 40 MB a week.",
            "options": [
                {"effect": "choice_only", "label": "Keep SQLite", "id": "sqlite"},
                {"paths": ["crates/amux-server/src/db/mod.rs"], "effect": "branch_code_change",
                 "label": "Move to Postgres", "id": "pg-1"}
            ]
        });
        assert_eq!(ask(reordered).canonical(), parsed.canonical());
        assert_eq!(parse_typed_ask(&Value::Null).unwrap(), TypedAskInput::Clear);
        // No options is a question too (docs/policy/amux-decision-maker.md §3).
        assert!(ask(json!({})).options.is_empty());
    }

    #[test]
    fn structural_mistakes_are_refused_before_anything_is_written() {
        let refused = |value: Value| parse_typed_ask(&value).unwrap_err().code;
        assert_eq!(refused(json!("decision_only")), "typed_ask_not_an_object");
        assert_eq!(
            refused(json!({"contextPaths": []})),
            "typed_ask_unknown_field"
        );
        assert_eq!(
            refused(json!({"options": [{"id": "a", "label": "x", "why": "y"}]})),
            "typed_ask_unknown_field"
        );
        assert_eq!(
            refused(json!({"options": {"id": "a"}})),
            "typed_ask_not_a_list"
        );
        assert_eq!(
            refused(json!({"options": [{"id": "a b", "label": "x"}]})),
            "typed_ask_option_id"
        );
        assert_eq!(
            refused(json!({"options": [{"id": "a", "label": "x"}, {"id": "a", "label": "y"}]})),
            "typed_ask_option_id_repeated"
        );
        assert_eq!(
            refused(json!({"options": [{"id": "a"}]})),
            "typed_ask_not_a_string"
        );
        assert_eq!(
            refused(json!({"options": [{"id": "a", "label": "x", "paths": "a.rs"}]})),
            "typed_ask_not_a_list"
        );
        assert_eq!(
            refused(json!({"resolution": "maybe"})),
            "typed_ask_resolution"
        );
        assert_eq!(refused(json!({"context": 4})), "typed_ask_not_a_string");
        assert_eq!(
            refused(json!({"context_paths": ["../secrets"]})),
            "typed_ask_path"
        );
        let paths: Vec<String> = (0..65).map(|i| format!("docs/{i}.md")).collect();
        assert_eq!(
            refused(json!({"context_paths": paths})),
            "typed_ask_context_paths_limit"
        );
        let paths: Vec<String> = (0..64).map(|i| format!("docs/{i}.md")).collect();
        assert_eq!(ask(json!({"context_paths": paths})).context_paths.len(), 64);
        assert_eq!(
            refused(json!({"context": "x".repeat(TYPED_ASK_MAX_BYTES)})),
            "typed_ask_too_large"
        );
        for resolution in RESOLUTIONS {
            assert_eq!(
                ask(json!({"resolution": resolution})).resolution.as_deref(),
                Some(resolution)
            );
        }
    }

    #[test]
    fn a_malformed_effect_declaration_is_recorded_as_other_not_refused() {
        let paths = |n: usize| (0..n).map(|i| format!("src/{i}.rs")).collect::<Vec<_>>();
        assert_eq!(recorded_effect(None, &[]), ("other".into(), vec![]));
        assert_eq!(
            recorded_effect(Some("ship_it"), &[]),
            ("other".into(), vec![])
        );
        assert_eq!(
            recorded_effect(Some("choice_only"), &[]),
            ("choice_only".into(), vec![])
        );
        assert_eq!(
            recorded_effect(Some("wait_or_defer"), &[]),
            ("wait_or_defer".into(), vec![])
        );
        assert_eq!(
            recorded_effect(Some("choice_only"), &paths(1)),
            ("other".into(), vec![])
        );
        assert_eq!(
            recorded_effect(Some("other"), &paths(1)),
            ("other".into(), vec![])
        );
        for class in CHANGE_EFFECT_CLASSES {
            assert_eq!(
                recorded_effect(Some(class), &paths(1)),
                (class.into(), paths(1))
            );
            assert_eq!(
                recorded_effect(Some(class), &paths(50)),
                (class.into(), paths(50))
            );
            assert_eq!(recorded_effect(Some(class), &[]), ("other".into(), vec![]));
            assert_eq!(
                recorded_effect(Some(class), &paths(51)),
                ("other".into(), vec![])
            );
            let bad = vec!["src/a.rs".to_string(), "../b.rs".to_string()];
            assert_eq!(recorded_effect(Some(class), &bad), ("other".into(), vec![]));
            let repeated = vec!["src/a.rs".to_string(), "src/a.rs".to_string()];
            assert_eq!(
                recorded_effect(Some(class), &repeated),
                ("other".into(), vec![])
            );
        }
        let parsed = ask(
            json!({"options": [{"id": "a", "label": "x", "effect": "deploy", "paths": ["src/a.rs"]}]}),
        );
        assert_eq!(
            (
                parsed.options[0].effect.as_str(),
                parsed.options[0].paths.len()
            ),
            ("other", 0)
        );
    }

    // -- question revisions ---------------------------------------------------

    #[test]
    fn a_revision_is_taken_when_a_typed_card_enters_needsyou_and_not_before() {
        let conn = db();
        card(&conn, "DM-1", "doing", 100);
        write_draft(&conn, "DM-1", &TypedAskInput::Set(ask(two_options())), 100).unwrap();
        assert_eq!(
            sync_question_revision(&conn, "DM-1", 100).unwrap(),
            None,
            "doing is not asking"
        );
        assert_eq!(current_revision(&conn, "DM-1").unwrap(), None);

        move_to(&conn, "DM-1", "needsyou", 200);
        assert_eq!(sync_question_revision(&conn, "DM-1", 200).unwrap(), Some(1));
        let current = current_revision(&conn, "DM-1").unwrap().unwrap();
        assert_eq!(current.question_revision, 1);
        assert_eq!(
            current.detail,
            ask(two_options()),
            "the draft written first is the question's extension"
        );
        // An unrelated write leaves the revision alone.
        assert_eq!(sync_question_revision(&conn, "DM-1", 210).unwrap(), Some(1));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM _amux_dm_ask_revisions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn a_legacy_needsyou_card_without_a_typed_ask_gets_no_revision() {
        let conn = db();
        conn.execute(
            "INSERT INTO issues (id, title, status, created, updated, entered_state_at) \
             VALUES ('OLD-1', 'untyped', 'needsyou', 1, 1, 1)",
            [],
        )
        .unwrap();
        assert_eq!(sync_question_revision(&conn, "OLD-1", 5).unwrap(), None);
        // Legacy spelling still counts as asking, once the ask is typed.
        card(&conn, "OLD-2", "needs_you", 1);
        assert_eq!(sync_question_revision(&conn, "OLD-2", 5).unwrap(), Some(1));
    }

    #[test]
    fn a_new_question_never_inherits_the_previous_questions_options() {
        let conn = db();
        card(&conn, "DM-2", "needsyou", 100);
        write_draft(&conn, "DM-2", &TypedAskInput::Set(ask(two_options())), 100).unwrap();
        assert_eq!(sync_question_revision(&conn, "DM-2", 100).unwrap(), Some(1));
        // The worker re-asks without restating typed_ask.
        conn.execute(
            "UPDATE issues SET ask_question = 'Should the index be dropped instead?' WHERE id = 'DM-2'",
            [],
        )
        .unwrap();
        assert_eq!(sync_question_revision(&conn, "DM-2", 110).unwrap(), Some(2));
        let current = current_revision(&conn, "DM-2").unwrap().unwrap();
        assert_eq!(
            current.detail,
            TypedAsk::empty(),
            "stale options must not ride on a new question"
        );
        // Revision 1 is unchanged.
        let first = revision(&conn, "DM-2", 1).unwrap().unwrap();
        assert_eq!(first.detail, ask(two_options()));
        assert_eq!(
            first.ask_question.as_deref(),
            Some("Which store should the index use?")
        );
    }

    #[test]
    fn changing_the_extension_while_asking_is_a_new_revision() {
        let conn = db();
        card(&conn, "DM-3", "needsyou", 100);
        write_draft(&conn, "DM-3", &TypedAskInput::Set(ask(two_options())), 100).unwrap();
        assert_eq!(sync_question_revision(&conn, "DM-3", 100).unwrap(), Some(1));
        let narrower = ask(
            json!({"options": [{"id": "sqlite", "label": "Keep SQLite", "effect": "choice_only"}]}),
        );
        let base = (
            Some("decision"),
            Some("Which store should the index use?"),
            Some("The owner names the store to use."),
        );
        let set = TypedAskInput::Set(narrower.clone());
        assert!(draft_differs(&conn, "DM-3", &set, base).unwrap());
        write_draft(&conn, "DM-3", &set, 110).unwrap();
        assert!(!draft_differs(&conn, "DM-3", &set, base).unwrap());
        // The same extension for a different question is a change: it is what
        // attaches the extension to the re-asked question.
        let reasked = (base.0, Some("Should the index be dropped?"), base.2);
        assert!(draft_differs(&conn, "DM-3", &set, reasked).unwrap());
        assert_eq!(sync_question_revision(&conn, "DM-3", 110).unwrap(), Some(2));
        assert_eq!(
            current_revision(&conn, "DM-3").unwrap().unwrap().detail,
            narrower
        );
        write_draft(&conn, "DM-3", &TypedAskInput::Clear, 120).unwrap();
        assert_eq!(draft_for(&conn, "DM-3").unwrap(), None);
        assert_eq!(sync_question_revision(&conn, "DM-3", 120).unwrap(), Some(3));
        assert_eq!(
            current_revision(&conn, "DM-3").unwrap().unwrap().detail,
            TypedAsk::empty()
        );
    }

    #[test]
    fn re_entering_needsyou_is_a_new_revision_even_with_the_same_text() {
        let conn = db();
        card(&conn, "DM-4", "needsyou", 100);
        assert_eq!(sync_question_revision(&conn, "DM-4", 100).unwrap(), Some(1));
        move_to(&conn, "DM-4", "doing", 150);
        assert_eq!(
            current_revision(&conn, "DM-4").unwrap(),
            None,
            "a card that left needsyou is asking nothing"
        );
        // Back with the same entry second: the clock cannot tell the two
        // episodes apart, the status epoch can.
        move_to(&conn, "DM-4", "needsyou", 100);
        assert_eq!(sync_question_revision(&conn, "DM-4", 100).unwrap(), Some(2));
    }

    #[test]
    fn a_card_moved_by_a_writer_that_records_no_revision_has_no_current_revision() {
        let conn = db();
        card(&conn, "DM-5", "needsyou", 100);
        assert_eq!(sync_question_revision(&conn, "DM-5", 100).unwrap(), Some(1));
        // Another door re-enters needsyou and never calls sync.
        move_to(&conn, "DM-5", "doing", 120);
        move_to(&conn, "DM-5", "needsyou", 130);
        assert_eq!(current_revision(&conn, "DM-5").unwrap(), None);
        assert_eq!(
            set_pending(&conn, "DM-5", 1, REQUEST_A, "decision-maker-openai", 131).unwrap(),
            PendingSet::Discarded(PendingDiscard::StaleRevision)
        );
    }

    fn epochs(conn: &Connection, id: &str) -> (i64, i64) {
        conn.query_row(
            "SELECT status_epoch, ask_epoch FROM _amux_dm_card_epochs WHERE issue_id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    /// The counters are the database's, so every writer moves them: a status
    /// change, a base-ask change and a replaced row each count once, and a
    /// write that leaves those columns as they were counts nothing.
    #[test]
    fn the_epochs_count_every_status_and_ask_change_by_any_writer() {
        let conn = db();
        card(&conn, "EP-1", "needsyou", 100);
        assert_eq!(epochs(&conn, "EP-1"), (1, 1), "an inserted row starts both");
        conn.execute(
            "UPDATE issues SET status = 'needsyou', ask_question = ask_question, \"desc\" = 'x' WHERE id = 'EP-1'",
            [],
        )
        .unwrap();
        assert_eq!(
            epochs(&conn, "EP-1"),
            (1, 1),
            "same values are not a change"
        );
        move_to(&conn, "EP-1", "doing", 100);
        move_to(&conn, "EP-1", "needsyou", 100);
        assert_eq!(epochs(&conn, "EP-1"), (3, 1));
        reword(&conn, "EP-1", "Another question?");
        conn.execute(
            "UPDATE issues SET ask_unblocks = NULL WHERE id = 'EP-1'",
            [],
        )
        .unwrap();
        assert_eq!(epochs(&conn, "EP-1"), (3, 3));
        conn.execute(
            "INSERT OR REPLACE INTO issues (id, title, status, created, updated) \
             VALUES ('EP-1', 'replaced', 'needsyou', 1, 1)",
            [],
        )
        .unwrap();
        assert_eq!(
            epochs(&conn, "EP-1"),
            (4, 4),
            "a replaced row counts as a change, and never resets the counters"
        );
        // The firing statement's conflict policy reaches into the trigger;
        // an outer OR REPLACE / OR IGNORE must not reset or skip the count.
        conn.execute(
            "UPDATE OR REPLACE issues SET status = 'doing' WHERE id = 'EP-1'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE OR IGNORE issues SET ask_question = 'Third question?' WHERE id = 'EP-1'",
            [],
        )
        .unwrap();
        assert_eq!(epochs(&conn, "EP-1"), (5, 5));
    }

    fn reword(conn: &Connection, id: &str, question: &str) {
        conn.execute(
            "UPDATE issues SET ask_question = ?2 WHERE id = ?1",
            params![id, question],
        )
        .unwrap();
    }

    /// Review r-20261016-230112-9bf37c, finding 1. A door that records no
    /// revision moves the card needsyou -> doing -> needsyou inside one
    /// second and keeps the wording. Seconds cannot tell the two episodes
    /// apart, so the old revision must not be current: its assignment and
    /// its answer belong to a question the card is no longer asking.
    #[test]
    fn another_door_re_entering_needsyou_within_the_same_second_voids_the_revision() {
        let conn = db();
        card(&conn, "DM-13", "needsyou", 100);
        assert_eq!(
            sync_question_revision(&conn, "DM-13", 100).unwrap(),
            Some(1)
        );
        assert!(matches!(
            claim_answer(&conn, "DM-13", 1, &AnswerSource::Operator, "Ethan", 100).unwrap(),
            AnswerClaim::Claimed(_)
        ));
        move_to(&conn, "DM-13", "doing", 100);
        move_to(&conn, "DM-13", "needsyou", 100);
        assert_eq!(
            current_revision(&conn, "DM-13").unwrap(),
            None,
            "the old revision must not stand for the new episode"
        );
        assert_eq!(
            set_pending(&conn, "DM-13", 1, REQUEST_A, "decision-maker-openai", 100).unwrap(),
            PendingSet::Discarded(PendingDiscard::StaleRevision)
        );
        // The next recording write gives the new episode its own revision,
        // and the old answer does not block the new question's answer.
        assert_eq!(
            sync_question_revision(&conn, "DM-13", 101).unwrap(),
            Some(2)
        );
        let confirmed = AnswerSource::DmConfirmed {
            request_id: REQUEST_A.into(),
        };
        assert!(matches!(
            claim_answer(&conn, "DM-13", 2, &confirmed, "amux-bridge", 102).unwrap(),
            AnswerClaim::Claimed(_)
        ));
    }

    /// The same finding, without a status change: another writer rewords the
    /// question and puts the old wording back. The wording matches, the
    /// question generation does not.
    #[test]
    fn another_writer_restoring_the_old_wording_does_not_revive_the_revision() {
        let conn = db();
        card(&conn, "DM-14", "needsyou", 100);
        assert_eq!(
            sync_question_revision(&conn, "DM-14", 100).unwrap(),
            Some(1)
        );
        reword(&conn, "DM-14", "Should the index be dropped instead?");
        reword(&conn, "DM-14", "Which store should the index use?");
        assert_eq!(current_revision(&conn, "DM-14").unwrap(), None);
        assert_eq!(
            set_pending(&conn, "DM-14", 1, REQUEST_A, "decision-maker-openai", 101).unwrap(),
            PendingSet::Discarded(PendingDiscard::StaleRevision)
        );
    }

    /// Review r-20261016-230112-9bf37c, finding 2. Question A is recorded
    /// with a typed ask, then A -> B -> A without `typed_ask`. The last A is
    /// a new question generation and must not get the first A's options,
    /// resolution or context back.
    #[test]
    fn a_question_reworded_back_does_not_get_its_old_draft_back() {
        let conn = db();
        card(&conn, "DM-15", "needsyou", 100);
        write_draft(&conn, "DM-15", &TypedAskInput::Set(ask(two_options())), 100).unwrap();
        assert_eq!(
            sync_question_revision(&conn, "DM-15", 100).unwrap(),
            Some(1)
        );
        assert_eq!(
            current_revision(&conn, "DM-15").unwrap().unwrap().detail,
            ask(two_options())
        );
        reword(&conn, "DM-15", "Should the index be dropped instead?");
        assert_eq!(
            sync_question_revision(&conn, "DM-15", 110).unwrap(),
            Some(2)
        );
        reword(&conn, "DM-15", "Which store should the index use?");
        assert_eq!(
            sync_question_revision(&conn, "DM-15", 120).unwrap(),
            Some(3)
        );
        assert_eq!(
            current_revision(&conn, "DM-15").unwrap().unwrap().detail,
            TypedAsk::empty(),
            "the first A's extension must not ride on the restored wording"
        );
    }

    #[test]
    fn revisions_and_answers_are_immutable_in_the_database() {
        let conn = db();
        card(&conn, "DM-6", "needsyou", 100);
        sync_question_revision(&conn, "DM-6", 100).unwrap();
        claim_answer(&conn, "DM-6", 1, &AnswerSource::Operator, "Ethan", 101).unwrap();
        for sql in [
            "UPDATE _amux_dm_ask_revisions SET ask_question = 'rewritten'",
            "DELETE FROM _amux_dm_ask_revisions",
            "UPDATE _amux_dm_answers SET source = 'dm_confirmed', request_id = 'x'",
            "DELETE FROM _amux_dm_answers",
        ] {
            let err = conn.execute(sql, []).unwrap_err().to_string();
            assert!(err.contains("immutable"), "{sql}: {err}");
        }
        // A second row for the same key is refused by the key itself.
        let dup = conn.execute(
            "INSERT INTO _amux_dm_answers (issue_id, question_revision, source, request_id, actor, recorded_at) \
             VALUES ('DM-6', 1, 'dm_confirmed', ?1, 'bridge', 102)",
            params![REQUEST_A],
        );
        assert!(dup.is_err());
        // No source can name an unconfirmed Decision Maker output.
        for source in ["dm_proposal", "select", "free_text", "escalate"] {
            let bad = conn.execute(
                "INSERT INTO _amux_dm_answers (issue_id, question_revision, source, request_id, actor, recorded_at) \
                 VALUES ('DM-6', 9, ?1, ?2, 'bridge', 102)",
                params![source, REQUEST_A],
            );
            assert!(bad.is_err(), "{source}");
        }
        let unpaired = conn.execute(
            "INSERT INTO _amux_dm_answers (issue_id, question_revision, source, request_id, actor, recorded_at) \
             VALUES ('DM-6', 9, 'dm_confirmed', NULL, 'bridge', 102)",
            [],
        );
        assert!(
            unpaired.is_err(),
            "a confirmed answer always names its request"
        );
    }

    // -- the DM-pending marker --------------------------------------------------

    #[test]
    fn the_marker_is_one_compare_and_swap_against_the_current_revision() {
        let conn = db();
        card(&conn, "DM-7", "needsyou", 100);
        sync_question_revision(&conn, "DM-7", 100).unwrap();
        let set = |rev: i64, request: &str, instance: &str| {
            set_pending(&conn, "DM-7", rev, request, instance, 101).unwrap()
        };

        assert_eq!(
            set(1, "not-a-uuid", "decision-maker-openai"),
            PendingSet::Discarded(PendingDiscard::InvalidRequestId)
        );
        assert_eq!(
            set(1, REQUEST_A, "decision-maker-gemini"),
            PendingSet::Discarded(PendingDiscard::UnknownInstance)
        );
        assert_eq!(
            set(2, REQUEST_A, "decision-maker-openai"),
            PendingSet::Discarded(PendingDiscard::StaleRevision)
        );
        assert!(matches!(
            set(1, REQUEST_A, "decision-maker-openai"),
            PendingSet::Set(_)
        ));
        assert!(
            matches!(
                set(1, REQUEST_A, "decision-maker-openai"),
                PendingSet::AlreadySet(_)
            ),
            "retry is idempotent"
        );
        assert_eq!(
            set(1, REQUEST_B, "decision-maker-openai"),
            PendingSet::Discarded(PendingDiscard::HeldByOtherRequest)
        );
        assert_eq!(
            set_pending(&conn, "NOPE-1", 1, REQUEST_A, "decision-maker-openai", 1).unwrap(),
            PendingSet::Discarded(PendingDiscard::CardMissing)
        );
        move_to(&conn, "DM-7", "doing", 120);
        assert_eq!(
            set(1, REQUEST_B, "decision-maker-openai"),
            PendingSet::Discarded(PendingDiscard::NotNeedsYou)
        );
    }

    #[test]
    fn an_answered_question_cannot_be_marked() {
        let conn = db();
        card(&conn, "DM-8", "needsyou", 100);
        sync_question_revision(&conn, "DM-8", 100).unwrap();
        assert!(matches!(
            claim_answer(&conn, "DM-8", 1, &AnswerSource::Operator, "Ethan", 101).unwrap(),
            AnswerClaim::Claimed(_)
        ));
        assert_eq!(
            set_pending(&conn, "DM-8", 1, REQUEST_A, "decision-maker-anthropic", 102).unwrap(),
            PendingSet::Discarded(PendingDiscard::Answered)
        );
    }

    #[test]
    fn release_compares_the_request_and_nothing_else() {
        let conn = db();
        card(&conn, "DM-9", "needsyou", 100);
        sync_question_revision(&conn, "DM-9", 100).unwrap();
        set_pending(&conn, "DM-9", 1, REQUEST_A, "decision-maker-openai", 101).unwrap();
        assert!(matches!(
            release_pending(&conn, "DM-9", 1, REQUEST_B).unwrap(),
            PendingRelease::HeldByOther(_)
        ));
        assert!(
            pending_for(&conn, "DM-9", 1).unwrap().is_some(),
            "a stranger's release leaves it in place"
        );
        // The card has moved on; the request can still release what it set.
        move_to(&conn, "DM-9", "doing", 150);
        assert!(matches!(
            release_pending(&conn, "DM-9", 1, REQUEST_A).unwrap(),
            PendingRelease::Released(_)
        ));
        assert_eq!(
            release_pending(&conn, "DM-9", 1, REQUEST_A).unwrap(),
            PendingRelease::NotHeld
        );
    }

    /// docs/policy/amux-decision-maker.md §12, blocking criterion: the card
    /// before confirmation does not depend on what the Decision Maker produced
    /// (`select`, `free_text`, `escalate`, a failure). Locally every outcome is
    /// the same two calls, so every outcome must leave the same card.
    #[test]
    fn the_card_before_confirmation_is_the_same_whatever_the_dm_produced() {
        let outcomes = [
            "select",
            "free_text",
            "escalate",
            "validation_failed",
            "timeout",
            "dm_unavailable",
        ];
        let mut states = Vec::new();
        for outcome in outcomes {
            let conn = db();
            card(&conn, "DM-10", "needsyou", 100);
            write_draft(&conn, "DM-10", &TypedAskInput::Set(ask(two_options())), 100).unwrap();
            sync_question_revision(&conn, "DM-10", 100).unwrap();
            let before = card_state(&conn, "DM-10");
            assert!(matches!(
                set_pending(&conn, "DM-10", 1, REQUEST_A, "decision-maker-openai", 101).unwrap(),
                PendingSet::Set(_)
            ));
            let marked = card_state(&conn, "DM-10");
            assert_eq!(
                marked["issue"], before["issue"],
                "{outcome}: the marker never touches the card row"
            );
            assert_eq!(marked["tags"], before["tags"], "{outcome}");
            // The outcome reaches the app only; locally there is nothing to
            // pass it to.
            assert!(matches!(
                release_pending(&conn, "DM-10", 1, REQUEST_A).unwrap(),
                PendingRelease::Released(_)
            ));
            let after = card_state(&conn, "DM-10");
            assert_eq!(
                after, before,
                "{outcome}: released, the card is exactly as the marker found it"
            );
            assert_eq!(
                answer_for(&conn, "DM-10", 1).unwrap(),
                None,
                "{outcome}: nothing was answered"
            );
            states.push(after);
        }
        assert!(
            states.windows(2).all(|w| w[0] == w[1]),
            "every outcome leaves the same card"
        );
    }

    // -- the answer record --------------------------------------------------------

    /// Stage S2-2b4: the operator's records only, from a time on, in the
    /// order of their time and then their question -- what the bridge reads to
    /// close the app's request of each question the operator answered directly.
    #[test]
    fn the_operators_answer_records_are_listed_by_time_without_the_confirmed_ones() {
        let conn = db();
        for (id, entered) in [("DM-21", 100), ("DM-22", 100), ("DM-23", 100), ("DM-24", 100)] {
            card(&conn, id, "needsyou", entered);
            write_draft(&conn, id, &TypedAskInput::Set(ask(two_options())), entered).unwrap();
            sync_question_revision(&conn, id, entered).unwrap();
        }
        let confirmed = AnswerSource::DmConfirmed {
            request_id: REQUEST_A.into(),
        };
        // Written in this order; two share a second, and the later-written one sorts first.
        claim_answer(&conn, "DM-23", 1, &AnswerSource::Operator, "Ethan", 300).unwrap();
        claim_answer(&conn, "DM-24", 1, &AnswerSource::Operator, "Ethan", 300).unwrap();
        claim_answer(&conn, "DM-22", 1, &AnswerSource::Operator, "Ethan", 300).unwrap();
        // A confirmed answer's record is not the operator's.
        claim_answer(&conn, "DM-21", 1, &confirmed, "amux-dm-relay", 250).unwrap();
        let listed = |after: (i64, &str, i64), limit: usize| -> Vec<(String, i64, i64)> {
            operator_answers_after(&conn, after, limit)
                .unwrap()
                .into_iter()
                .map(|record| {
                    assert_eq!(record.source, "operator");
                    assert_eq!(record.request_id, None);
                    (record.issue_id, record.question_revision, record.recorded_at)
                })
                .collect()
        };
        let all = listed((0, "", i64::MIN), 10);
        assert_eq!(
            all,
            vec![
                ("DM-22".to_string(), 1, 300),
                ("DM-23".to_string(), 1, 300),
                ("DM-24".to_string(), 1, 300),
            ]
        );
        // Strictly after a record: the rest of its second, then later seconds.
        assert_eq!(
            listed((300, "DM-22", 1), 10),
            vec![("DM-23".to_string(), 1, 300), ("DM-24".to_string(), 1, 300)]
        );
        assert_eq!(listed((300, "DM-24", 1), 10), Vec::<(String, i64, i64)>::new());
        // Pages of one move on inside a single second: a read by time alone never
        // left a second that held a full page (review r-20261018-121437-f0d9ce).
        let mut after = (0_i64, String::new(), i64::MIN);
        let mut walked = Vec::new();
        loop {
            let page = listed((after.0, after.1.as_str(), after.2), 1);
            let Some((card, revision, at)) = page.last().cloned() else {
                break;
            };
            walked.extend(page);
            after = (at, card, revision);
        }
        assert_eq!(walked, all);
    }

    /// docs/policy/amux-decision-maker.md §12, blocking criterion: a direct
    /// answer and a confirmed answer arriving together deliver one answer.
    /// Each producer does what a caller must: claim, then send only on
    /// `Claimed`. Both arrival orders.
    #[test]
    fn a_direct_answer_and_a_confirmed_answer_deliver_exactly_one() {
        let confirmed = AnswerSource::DmConfirmed {
            request_id: REQUEST_A.into(),
        };
        for operator_first in [true, false] {
            let conn = db();
            card(&conn, "DM-11", "needsyou", 100);
            sync_question_revision(&conn, "DM-11", 100).unwrap();
            set_pending(&conn, "DM-11", 1, REQUEST_A, "decision-maker-openai", 101).unwrap();

            let mut delivered: Vec<String> = Vec::new();
            let mut answer = |source: &AnswerSource, actor: &str, text: &str, at: i64| {
                let claim = claim_answer(&conn, "DM-11", 1, source, actor, at).unwrap();
                if let AnswerClaim::Claimed(_) = claim {
                    delivered.push(text.to_string());
                }
                claim
            };
            let (first, second) = if operator_first {
                (
                    answer(&AnswerSource::Operator, "Ethan", "use sqlite", 110),
                    answer(
                        &confirmed,
                        "amux-bridge",
                        "[Decision Maker] use postgres",
                        111,
                    ),
                )
            } else {
                (
                    answer(
                        &confirmed,
                        "amux-bridge",
                        "[Decision Maker] use postgres",
                        110,
                    ),
                    answer(&AnswerSource::Operator, "Ethan", "use sqlite", 111),
                )
            };
            assert_eq!(delivered.len(), 1, "exactly one answer is sent");
            let winner = match first {
                AnswerClaim::Claimed(winner) => winner,
                other => panic!("the first claim wins: {other:?}"),
            };
            let shown = match second {
                AnswerClaim::AlreadyAnswered(shown) => shown,
                other => panic!("the second is refused: {other:?}"),
            };
            assert_eq!(shown, winner, "the refusal names the answer that was sent");
            assert_eq!(
                winner.source,
                if operator_first {
                    "operator"
                } else {
                    "dm_confirmed"
                }
            );
            assert_eq!(winner.request_id.is_some(), !operator_first);
            assert_eq!(
                pending_for(&conn, "DM-11", 1).unwrap(),
                None,
                "an answered question is no longer pending"
            );
            // And the record outlives every later attempt.
            assert!(matches!(
                claim_answer(&conn, "DM-11", 1, &AnswerSource::Operator, "Ethan", 200).unwrap(),
                AnswerClaim::AlreadyAnswered(_)
            ));
        }
    }

    #[test]
    fn an_answer_to_a_question_the_worker_replaced_is_refused() {
        let conn = db();
        card(&conn, "DM-12", "needsyou", 100);
        sync_question_revision(&conn, "DM-12", 100).unwrap();
        conn.execute(
            "UPDATE issues SET ask_question = 'A different question?' WHERE id = 'DM-12'",
            [],
        )
        .unwrap();
        sync_question_revision(&conn, "DM-12", 110).unwrap();
        let confirmed = AnswerSource::DmConfirmed {
            request_id: REQUEST_A.into(),
        };
        assert_eq!(
            claim_answer(&conn, "DM-12", 1, &confirmed, "amux-bridge", 120).unwrap(),
            AnswerClaim::Refused(AnswerRefusal::StaleRevision)
        );
        assert!(matches!(
            claim_answer(&conn, "DM-12", 2, &AnswerSource::Operator, "Ethan", 121).unwrap(),
            AnswerClaim::Claimed(_)
        ));
        move_to(&conn, "DM-12", "doing", 130);
        assert_eq!(
            claim_answer(&conn, "DM-12", 3, &AnswerSource::Operator, "Ethan", 131).unwrap(),
            AnswerClaim::Refused(AnswerRefusal::NotNeedsYou)
        );
        assert_eq!(
            claim_answer(&conn, "NOPE-2", 1, &AnswerSource::Operator, "Ethan", 131).unwrap(),
            AnswerClaim::Refused(AnswerRefusal::CardMissing)
        );
        assert_eq!(
            claim_answer(
                &conn,
                "DM-12",
                2,
                &AnswerSource::DmConfirmed {
                    request_id: "x".into()
                },
                "amux-bridge",
                1
            )
            .unwrap(),
            AnswerClaim::Refused(AnswerRefusal::InvalidRequestId)
        );
        assert_eq!(
            claim_answer(&conn, "DM-12", 2, &AnswerSource::Operator, "  ", 1).unwrap(),
            AnswerClaim::Refused(AnswerRefusal::MissingActor)
        );
    }

    #[test]
    fn request_ids_are_the_apps_lowercase_uuid() {
        assert!(is_request_id(REQUEST_A));
        for bad in [
            "",
            "0F8FAD5B-D9CB-469F-A165-70867728950E",
            "0f8fad5bd9cb469fa16570867728950e",
            "0f8fad5b-d9cb-469f-a165-70867728950",
            "g f8fad5b-d9cb-469f-a165-70867728950e",
        ] {
            assert!(!is_request_id(bad), "{bad}");
        }
    }
}
