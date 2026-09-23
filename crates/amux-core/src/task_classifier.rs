//! Deterministic first-stage task classification for intelligent routing.
//!
//! This module is deliberately pure: no model calls, no I/O, no clock and no
//! provider state. It extracts high-confidence signals and risk floors before
//! the model classifier runs. Ambiguous or high-risk work sets `needs_model`
//! so the server can escalate through normal/premium classifier tiers.

use crate::board::ItemType;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Architecture,
    Reasoning,
    Feature,
    Bugfix,
    Iteration,
    Refactor,
    Migration,
    DependencyUpgrade,
    Tests,
    Review,
    Security,
    Integration,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Architecture => "architecture",
            Self::Reasoning => "reasoning",
            Self::Feature => "feature",
            Self::Bugfix => "bugfix",
            Self::Iteration => "iteration",
            Self::Refactor => "refactor",
            Self::Migration => "migration",
            Self::DependencyUpgrade => "dependency_upgrade",
            Self::Tests => "tests",
            Self::Review => "review",
            Self::Security => "security",
            Self::Integration => "integration",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClassificationInput<'a> {
    pub title: &'a str,
    pub desc: &'a str,
    pub item_type: ItemType,
    pub tags: &'a [String],
    pub expected_files: &'a [String],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeterministicClassification {
    pub task_kind: TaskKind,
    pub complexity: u8,
    pub risk: u8,
    pub confidence: f64,
    pub risk_floor: u8,
    pub signals: Vec<String>,
    pub needs_model: bool,
}

fn normalize(parts: impl IntoIterator<Item = String>) -> String {
    let mut out = String::new();
    for part in parts {
        if !out.is_empty() {
            out.push(' ');
        }
        for ch in part.chars().flat_map(char::to_lowercase) {
            if ch.is_alphanumeric() {
                out.push(ch);
            } else {
                out.push(' ');
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn has_word(text: &str, word: &str) -> bool {
    text.split_whitespace().any(|w| w == word)
}

fn has_phrase(text: &str, phrase: &str) -> bool {
    text.contains(phrase)
}

fn any_word(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| has_word(text, w))
}

fn any_phrase(text: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|p| has_phrase(text, p))
}

fn add(scores: &mut BTreeMap<TaskKind, i32>, kind: TaskKind, amount: i32) {
    *scores.entry(kind).or_default() += amount;
}

fn push_signal(signals: &mut Vec<String>, signal: &str) {
    if !signals.iter().any(|s| s == signal) {
        signals.push(signal.to_string());
    }
}

pub fn classify(input: &ClassificationInput<'_>) -> DeterministicClassification {
    // Semantic kind/risk inference uses task-authored text and tags only.
    // Expected file paths are scope evidence, not prose: a path such as
    // `migrations/0083_add_index.sql` contains generic tokens like `add` that
    // must not turn a migration into a feature. File count still contributes
    // to complexity below.
    let text = normalize(
        [input.title.to_string(), input.desc.to_string()]
            .into_iter()
            .chain(input.tags.iter().cloned()),
    );

    let mut scores = BTreeMap::<TaskKind, i32>::new();
    let mut signals = Vec::<String>::new();

    // Item type is a prior, never a verdict.
    match input.item_type {
        ItemType::Code => add(&mut scores, TaskKind::Feature, 2),
        ItemType::Investigation | ItemType::Research => add(&mut scores, TaskKind::Reasoning, 3),
        ItemType::Chore => add(&mut scores, TaskKind::Iteration, 2),
        ItemType::Ops => add(&mut scores, TaskKind::Integration, 2),
        ItemType::Escalation | ItemType::Blocker => add(&mut scores, TaskKind::Reasoning, 2),
        ItemType::Doc | ItemType::Decision => add(&mut scores, TaskKind::Iteration, 1),
        ItemType::Tripwire | ItemType::Watch => add(&mut scores, TaskKind::Reasoning, 1),
        ItemType::Epic => add(&mut scores, TaskKind::Architecture, 1),
    }

    if any_phrase(
        &text,
        &[
            "architecture",
            "system design",
            "design doc",
            "technical design",
            "task decomposition",
            "dependency dag",
        ],
    ) || any_word(&text, &["rfc", "adr"])
    {
        add(&mut scores, TaskKind::Architecture, 7);
        push_signal(&mut signals, "kind:architecture");
    }

    if any_word(&text, &["migration", "migrate", "backfill"])
        || any_phrase(
            &text,
            &["schema change", "schema migration", "data migration"],
        )
    {
        add(&mut scores, TaskKind::Migration, 7);
        push_signal(&mut signals, "kind:migration");
    }

    let dependency_signal = any_phrase(
        &text,
        &[
            "dependency upgrade",
            "upgrade dependency",
            "upgrade dependencies",
            "package upgrade",
            "version bump",
        ],
    ) || (any_word(&text, &["dependency", "dependencies", "package"])
        && any_word(&text, &["upgrade", "bump", "update"]));
    if dependency_signal {
        add(&mut scores, TaskKind::DependencyUpgrade, 7);
        push_signal(&mut signals, "kind:dependency_upgrade");
    }

    if any_word(&text, &["security", "vulnerability", "cve"])
        || any_phrase(
            &text,
            &[
                "security hardening",
                "privilege escalation",
                "credential leak",
                "secret leak",
            ],
        )
    {
        add(&mut scores, TaskKind::Security, 7);
        push_signal(&mut signals, "kind:security");
    }

    if any_phrase(
        &text,
        &["code review", "architecture review", "security review"],
    ) || any_word(&text, &["review", "audit"])
    {
        add(&mut scores, TaskKind::Review, 6);
        push_signal(&mut signals, "kind:review");
    }

    if any_word(
        &text,
        &[
            "test", "tests", "testing", "coverage", "fixture", "fixtures",
        ],
    ) || any_phrase(&text, &["flaky test", "integration test", "unit test"])
    {
        add(&mut scores, TaskKind::Tests, 6);
        push_signal(&mut signals, "kind:tests");
    }

    if any_word(
        &text,
        &["refactor", "refactoring", "restructure", "cleanup"],
    ) || any_phrase(&text, &["simplify code", "code cleanup"])
    {
        add(&mut scores, TaskKind::Refactor, 6);
        push_signal(&mut signals, "kind:refactor");
    }

    if any_word(
        &text,
        &[
            "bug",
            "bugfix",
            "regression",
            "crash",
            "broken",
            "failure",
            "failing",
        ],
    ) || any_phrase(&text, &["fix error", "fix failure", "root cause"])
    {
        add(&mut scores, TaskKind::Bugfix, 6);
        push_signal(&mut signals, "kind:bugfix");
    }

    if any_word(
        &text,
        &["investigate", "investigation", "analyze", "analysis"],
    ) || any_phrase(&text, &["root cause", "reason about", "research why"])
    {
        add(&mut scores, TaskKind::Reasoning, 5);
        push_signal(&mut signals, "kind:reasoning");
    }

    if any_word(&text, &["integrate", "integration"])
        || any_phrase(
            &text,
            &[
                "merge conflict",
                "ci pipeline",
                "continuous integration",
                "end to end",
            ],
        )
    {
        add(&mut scores, TaskKind::Integration, 5);
        push_signal(&mut signals, "kind:integration");
    }

    if any_word(&text, &["tweak", "polish", "rename"])
        || any_phrase(&text, &["small change", "quick change", "minor change"])
    {
        add(&mut scores, TaskKind::Iteration, 5);
        push_signal(&mut signals, "kind:iteration");
    }

    if any_word(&text, &["implement", "add", "create", "build"])
        || any_phrase(&text, &["new feature", "support for"])
    {
        add(&mut scores, TaskKind::Feature, 5);
        push_signal(&mut signals, "kind:feature");
    }

    // Tiny documentation edits should not be mistaken for hard bugfixes.
    let trivial_doc = any_word(&text, &["typo", "spelling", "readme"])
        || any_phrase(&text, &["documentation typo", "docs typo"]);
    if trivial_doc {
        scores.clear();
        add(&mut scores, TaskKind::Iteration, 9);
        push_signal(&mut signals, "scope:trivial_doc");
    }

    // Risk floor: a model may raise risk, but it may not lower these hard signals
    // without a later explicit policy decision.
    let auth = any_word(
        &text,
        &[
            "auth",
            "authentication",
            "authorization",
            "oauth",
            "token",
            "jwt",
        ],
    );
    let permission = any_word(
        &text,
        &["permission", "permissions", "privilege", "acl", "rbac"],
    );
    let crypto = any_word(&text, &["encryption", "decrypt", "crypto", "cryptography"]);
    let payment = any_word(
        &text,
        &["payment", "payments", "billing", "invoice", "checkout"],
    );
    let destructive = any_word(&text, &["truncate", "drop", "delete", "purge", "destroy"])
        && any_word(&text, &["table", "database", "data", "records", "rows"]);
    let concurrency = any_word(
        &text,
        &["concurrency", "race", "deadlock", "locking", "mutex"],
    );
    let breaking_api = any_phrase(
        &text,
        &[
            "breaking api",
            "breaking change",
            "public api change",
            "api compatibility",
        ],
    );
    let db_migration = (has_word(&text, "database") || has_word(&text, "schema"))
        && (has_word(&text, "migration") || has_word(&text, "migrate"));

    let mut risk_floor = 1u8;
    for (hit, name) in [
        (auth, "risk:auth"),
        (permission, "risk:permissions"),
        (crypto, "risk:crypto"),
        (payment, "risk:payment"),
        (destructive, "risk:destructive"),
        (concurrency, "risk:concurrency"),
        (breaking_api, "risk:public_api"),
        (db_migration, "risk:db_migration"),
    ] {
        if hit {
            risk_floor = 3;
            push_signal(&mut signals, name);
        }
    }
    if scores.get(&TaskKind::Security).copied().unwrap_or(0) >= 7 {
        risk_floor = 3;
        push_signal(&mut signals, "risk:security");
    }

    let default_risk = match input.item_type {
        ItemType::Code | ItemType::Ops | ItemType::Investigation => 2,
        _ => 1,
    };
    let risk = risk_floor.max(default_risk);

    // Complexity is deliberately coarse. Telemetry will replace these priors.
    let mut complexity: i32 = match input.item_type {
        ItemType::Code => 4,
        ItemType::Investigation | ItemType::Research => 4,
        ItemType::Ops => 5,
        ItemType::Epic => 6,
        ItemType::Escalation | ItemType::Blocker => 5,
        ItemType::Chore | ItemType::Doc | ItemType::Decision => 2,
        ItemType::Tripwire | ItemType::Watch => 3,
    };

    if scores.get(&TaskKind::Architecture).copied().unwrap_or(0) >= 7 {
        complexity += 2;
    }
    if scores.get(&TaskKind::Migration).copied().unwrap_or(0) >= 7 {
        complexity += 2;
    }
    if db_migration {
        complexity += 1;
    }
    if risk_floor == 3 {
        complexity += 1;
    }
    if any_phrase(
        &text,
        &[
            "multi file",
            "multiple files",
            "repo wide",
            "repository wide",
            "cross service",
        ],
    ) {
        complexity += 1;
        push_signal(&mut signals, "scope:multi_file");
    }
    if input.expected_files.len() >= 5 {
        complexity += 2;
        push_signal(&mut signals, "scope:many_expected_files");
    } else if input.expected_files.len() >= 2 {
        complexity += 1;
    }
    if trivial_doc {
        complexity = 1;
    }
    let complexity = complexity.clamp(1, 10) as u8;

    let mut ranked = scores
        .iter()
        .map(|(kind, score)| (*kind, *score))
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let (task_kind, top) = ranked.first().copied().unwrap_or((TaskKind::Feature, 0));
    let second = ranked.get(1).map(|(_, score)| *score).unwrap_or(0);
    let margin = (top - second).max(0);

    let mut confidence = if top == 0 {
        0.45
    } else {
        0.55 + (top.min(8) as f64 * 0.04) + (margin.min(4) as f64 * 0.03)
    };
    if trivial_doc {
        confidence = 0.97;
    }
    confidence = confidence.clamp(0.0, 0.97);

    let ambiguous = top == 0 || margin <= 1 || confidence < 0.86;
    let needs_model = ambiguous || risk_floor == 3;

    DeterministicClassification {
        task_kind,
        complexity,
        risk,
        confidence,
        risk_floor,
        signals,
        needs_model,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify_text(
        title: &str,
        desc: &str,
        item_type: ItemType,
        tags: &[&str],
    ) -> DeterministicClassification {
        let tags = tags.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let files = Vec::<String>::new();
        classify(&ClassificationInput {
            title,
            desc,
            item_type,
            tags: &tags,
            expected_files: &files,
        })
    }

    #[test]
    fn postgres_schema_migration_is_complex_and_risk_three() {
        let c = classify_text(
            "Perform PostgreSQL schema migration",
            "Migrate the database schema and backfill existing rows.",
            ItemType::Code,
            &["database"],
        );
        assert_eq!(c.task_kind, TaskKind::Migration);
        assert_eq!(c.risk, 3);
        assert_eq!(c.risk_floor, 3);
        assert!(c.complexity >= 8, "{c:?}");
        assert!(c.confidence >= 0.86, "{c:?}");
        assert!(
            c.needs_model,
            "Risk-3 work escalates even when the kind is obvious"
        );
    }

    #[test]
    fn auth_refactor_keeps_refactor_kind_but_forces_risk_three() {
        let c = classify_text(
            "Refactor authentication session handling",
            "Restructure OAuth token refresh to resolve intermittent failures.",
            ItemType::Code,
            &["auth"],
        );
        assert_eq!(c.task_kind, TaskKind::Refactor);
        assert_eq!(c.risk_floor, 3);
        assert_eq!(c.risk, 3);
        assert!(c.needs_model);
        assert!(c.signals.iter().any(|s| s == "risk:auth"));
    }

    #[test]
    fn dependency_upgrade_is_not_generic_feature_work() {
        let c = classify_text(
            "Upgrade dependency versions",
            "Bump the database client package and update lockfiles.",
            ItemType::Chore,
            &[],
        );
        assert_eq!(c.task_kind, TaskKind::DependencyUpgrade);
        assert!(c.confidence >= 0.86, "{c:?}");
    }

    #[test]
    fn readme_typo_is_a_low_risk_low_complexity_iteration() {
        let c = classify_text(
            "Fix typo in README",
            "Correct spelling only.",
            ItemType::Doc,
            &["docs"],
        );
        assert_eq!(c.task_kind, TaskKind::Iteration);
        assert_eq!(c.risk, 1);
        assert_eq!(c.complexity, 1);
        assert!(!c.needs_model);
    }

    #[test]
    fn explicit_security_review_is_security_and_risk_three() {
        let c = classify_text(
            "Security review of authorization checks",
            "Audit RBAC permission boundaries.",
            ItemType::Investigation,
            &["security"],
        );
        assert_eq!(c.task_kind, TaskKind::Security);
        assert_eq!(c.risk, 3);
        assert!(c.needs_model);
    }

    #[test]
    fn vague_code_work_escalates_instead_of_inventing_confidence() {
        let c = classify_text(
            "Improve handler behavior",
            "Make the current behavior better.",
            ItemType::Code,
            &[],
        );
        assert_eq!(c.task_kind, TaskKind::Feature);
        assert!(c.confidence < 0.86, "{c:?}");
        assert!(c.needs_model);
    }

    #[test]
    fn expected_file_names_do_not_pollute_semantic_kind_scoring() {
        let tags = vec!["database".to_string()];
        let files = vec![
            "migrations/0083_add_index.sql".to_string(),
            "src/db/store.rs".to_string(),
        ];
        let c = classify(&ClassificationInput {
            title: "Perform PostgreSQL schema migration",
            desc: "Migrate the database schema and backfill existing rows.",
            item_type: ItemType::Code,
            tags: &tags,
            expected_files: &files,
        });
        assert_eq!(c.task_kind, TaskKind::Migration);
        assert_eq!(c.risk, 3);
        assert!(c.signals.iter().any(|s| s == "risk:db_migration"));
    }

    #[test]
    fn expected_file_count_raises_complexity_without_changing_kind() {
        let tags = Vec::<String>::new();
        let files = (0..6)
            .map(|i| format!("src/module_{i}.rs"))
            .collect::<Vec<_>>();
        let c = classify(&ClassificationInput {
            title: "Implement export feature",
            desc: "Add export support.",
            item_type: ItemType::Code,
            tags: &tags,
            expected_files: &files,
        });
        assert_eq!(c.task_kind, TaskKind::Feature);
        assert!(c.complexity >= 6, "{c:?}");
        assert!(c.signals.iter().any(|s| s == "scope:many_expected_files"));
    }
}
