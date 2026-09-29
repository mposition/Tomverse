use serde::{Deserialize, Serialize};

const NEUTRAL_PRIOR: f64 = 0.5;

const W_TASK_FIT: f64 = 0.30;
const W_PREDICTED_SUCCESS: f64 = 0.20;
const W_QUOTA_REMAINING: f64 = 0.20;
const W_EXPECTED_SPEED: f64 = 0.10;
const W_LOW_REWORK: f64 = 0.10;
const W_LOW_HUMAN_ATTENTION: f64 = 0.05;
const W_COST_EFFICIENCY: f64 = 0.05;

/// Intrinsic preference excludes quota only, then normalizes the remaining
/// declared weight back onto [0, 1].
const INTRINSIC_WEIGHT_TOTAL: f64 = 0.80;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoutingTaskProfile {
    pub task_kind: String,
    pub complexity: i64,
    pub risk: i64,
    pub files_expected: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoutingWorkerCandidate {
    pub worker_name: String,
    pub provider: String,

    /// Explicitly observed/configured model only. None is unknown.
    pub model: Option<String>,

    /// Explicit capability declarations. Worker names are identity only.
    pub routing_roles: Vec<String>,

    pub running: bool,
    pub status: String,

    /// Positive evidence that delivery is currently safe.
    pub dispatch_ready: bool,

    pub archived: bool,
    pub paused: bool,
    pub isolated: bool,
    pub blocked: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateRoutingSignals {
    pub worker: RoutingWorkerCandidate,

    pub predicted_success: Option<f64>,
    pub quota_remaining: Option<f64>,
    pub expected_speed: Option<f64>,
    pub low_rework: Option<f64>,
    pub low_human_attention: Option<f64>,
    pub cost_efficiency: Option<f64>,

    /// Only positive, trustworthy capacity evidence sets this true.
    pub provider_exhausted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MetricBreakdown {
    pub value: f64,
    pub observed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TaskFitBreakdown {
    pub role_fit: f64,
    pub provider_fit: f64,
    pub combined: f64,
    pub large_task: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CandidateScoreBreakdown {
    pub task_fit: TaskFitBreakdown,
    pub predicted_success: MetricBreakdown,
    pub quota_remaining: MetricBreakdown,
    pub expected_speed: MetricBreakdown,
    pub low_rework: MetricBreakdown,
    pub low_human_attention: MetricBreakdown,
    pub cost_efficiency: MetricBreakdown,

    /// Full declared 1.00-weight score.
    pub selected_score: f64,

    /// Same evidence except quota, normalized from 0.80 back to 1.00.
    pub intrinsic_score: f64,

    pub operationally_allowed: bool,
    pub provider_exhausted: bool,
    pub selected_eligible: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ScoredWorker {
    pub worker_name: String,
    pub provider: String,
    pub breakdown: CandidateScoreBreakdown,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RoutingScoreResult {
    pub preferred_worker: Option<String>,
    pub selected_worker: Option<String>,
    pub preferred_score: Option<f64>,
    pub selected_score: Option<f64>,
    pub candidates: Vec<ScoredWorker>,
}

/// Pure AMUX worker scorer.
///
/// preferred_worker:
///   intrinsic task demand, excluding quota/exhaustion from the score.
///
/// selected_worker:
///   actual quota-aware selection, with operational exclusions applied.
pub fn score_execute_candidates(
    task: &RoutingTaskProfile,
    candidates: &[CandidateRoutingSignals],
) -> RoutingScoreResult {
    let mut scored = candidates
        .iter()
        .map(|signals| score_one(task, signals))
        .collect::<Vec<_>>();

    // Stable trace order independent of candidate discovery order.
    scored.sort_by(|a, b| a.worker_name.cmp(&b.worker_name));

    let preferred = best_by(&scored, false);
    let selected = best_by(&scored, true);

    RoutingScoreResult {
        preferred_worker: preferred.map(|worker| worker.worker_name.clone()),
        selected_worker: selected.map(|worker| worker.worker_name.clone()),
        preferred_score: preferred.map(|worker| worker.breakdown.intrinsic_score),
        selected_score: selected.map(|worker| worker.breakdown.selected_score),
        candidates: scored,
    }
}

fn score_one(task: &RoutingTaskProfile, signals: &CandidateRoutingSignals) -> ScoredWorker {
    let task_fit = task_fit(task, &signals.worker);

    let predicted_success = metric(signals.predicted_success);

    // Proven exhaustion is observed zero capacity.
    // Unknown/stale quota remains neutral and never implies exhaustion.
    let quota_remaining = if signals.provider_exhausted {
        MetricBreakdown {
            value: 0.0,
            observed: true,
        }
    } else {
        metric(signals.quota_remaining)
    };

    let expected_speed = metric(signals.expected_speed);
    let low_rework = metric(signals.low_rework);
    let low_human_attention = metric(signals.low_human_attention);
    let cost_efficiency = metric(signals.cost_efficiency);

    let selected_score = W_TASK_FIT * task_fit.combined
        + W_PREDICTED_SUCCESS * predicted_success.value
        + W_QUOTA_REMAINING * quota_remaining.value
        + W_EXPECTED_SPEED * expected_speed.value
        + W_LOW_REWORK * low_rework.value
        + W_LOW_HUMAN_ATTENTION * low_human_attention.value
        + W_COST_EFFICIENCY * cost_efficiency.value;

    let intrinsic_score = (W_TASK_FIT * task_fit.combined
        + W_PREDICTED_SUCCESS * predicted_success.value
        + W_EXPECTED_SPEED * expected_speed.value
        + W_LOW_REWORK * low_rework.value
        + W_LOW_HUMAN_ATTENTION * low_human_attention.value
        + W_COST_EFFICIENCY * cost_efficiency.value)
        / INTRINSIC_WEIGHT_TOTAL;

    let operationally_allowed = !signals.worker.archived
        && !signals.worker.paused
        && !signals.worker.isolated
        && !signals.worker.blocked;

    // A stopped worker remains selectable because the later execution layer
    // owns worker startup.
    //
    // Running + idle-looking + no recognized delivery boundary is different:
    // do not strand new ownership there. It remains visible as preferred demand.
    let idle_without_boundary = signals.worker.running
        && signals.worker.status.eq_ignore_ascii_case("idle")
        && !signals.worker.dispatch_ready;

    let selected_eligible =
        operationally_allowed && !signals.provider_exhausted && !idle_without_boundary;

    ScoredWorker {
        worker_name: signals.worker.worker_name.clone(),
        provider: signals.worker.provider.clone(),
        breakdown: CandidateScoreBreakdown {
            task_fit,
            predicted_success,
            quota_remaining,
            expected_speed,
            low_rework,
            low_human_attention,
            cost_efficiency,
            selected_score,
            intrinsic_score,
            operationally_allowed,
            provider_exhausted: signals.provider_exhausted,
            selected_eligible,
        },
    }
}

fn best_by(scored: &[ScoredWorker], selected: bool) -> Option<&ScoredWorker> {
    let mut eligible = scored
        .iter()
        .filter(|worker| {
            if selected {
                worker.breakdown.selected_eligible
            } else {
                worker.breakdown.operationally_allowed
            }
        })
        .collect::<Vec<_>>();

    eligible.sort_by(|a, b| {
        let a_score = if selected {
            a.breakdown.selected_score
        } else {
            a.breakdown.intrinsic_score
        };

        let b_score = if selected {
            b.breakdown.selected_score
        } else {
            b.breakdown.intrinsic_score
        };

        b_score
            .total_cmp(&a_score)
            .then_with(|| a.worker_name.cmp(&b.worker_name))
    });

    eligible.into_iter().next()
}

fn metric(value: Option<f64>) -> MetricBreakdown {
    match value.filter(|value| value.is_finite()) {
        Some(value) => MetricBreakdown {
            value: value.clamp(0.0, 1.0),
            observed: true,
        },
        None => MetricBreakdown {
            value: NEUTRAL_PRIOR,
            observed: false,
        },
    }
}

fn task_fit(task: &RoutingTaskProfile, worker: &RoutingWorkerCandidate) -> TaskFitBreakdown {
    let large_task = task.complexity >= 7 || task.files_expected.unwrap_or(0) >= 6;

    let role_fit = role_fit(&task.task_kind, &worker.routing_roles, large_task);

    let provider_fit = provider_fit(&task.task_kind, &worker.provider, large_task);

    // Explicit roles are primary capability evidence.
    // Provider family is only a secondary prior.
    let combined = (0.75 * role_fit + 0.25 * provider_fit).clamp(0.0, 1.0);

    TaskFitBreakdown {
        role_fit,
        provider_fit,
        combined,
        large_task,
    }
}

fn role_fit(kind: &str, roles: &[String], large_task: bool) -> f64 {
    let has = |role: &str| roles.iter().any(|candidate| candidate == role);

    let mut fit: f64 = if has(kind) { 1.0 } else { 0.0 };

    match kind {
        "architecture" => {
            if has("reasoning") {
                fit = fit.max(0.85);
            }
            if has("contract") {
                fit = fit.max(0.80);
            }
            if has("review") {
                fit = fit.max(0.55);
            }
        }
        "reasoning" => {
            if has("architecture") {
                fit = fit.max(0.85);
            }
            if has("review") {
                fit = fit.max(0.65);
            }
        }
        "feature" => {
            if has("implementation") {
                fit = fit.max(0.90);
            }
            if large_task && has("multi_file") {
                fit = fit.max(0.90);
            }
            if large_task && has("long_running") {
                fit = fit.max(0.80);
            }
        }
        "bugfix" => {
            if has("implementation") {
                fit = fit.max(0.85);
            }
            if has("reasoning") {
                fit = fit.max(0.80);
            }
            if has("tests") {
                fit = fit.max(0.65);
            }
        }
        "iteration" => {
            if has("implementation") {
                fit = fit.max(0.70);
            }
            if has("bugfix") {
                fit = fit.max(0.70);
            }
        }
        "refactor" => {
            if has("implementation") {
                fit = fit.max(0.85);
            }
            if large_task && has("multi_file") {
                fit = fit.max(0.90);
            }
        }
        "migration" => {
            if has("implementation") {
                fit = fit.max(0.65);
            }
            if has("reasoning") {
                fit = fit.max(0.65);
            }
            if has("multi_file") {
                fit = fit.max(0.85);
            }
        }
        "dependency_upgrade" => {
            if has("implementation") {
                fit = fit.max(0.60);
            }
            if has("tests") {
                fit = fit.max(0.75);
            }
            if has("multi_file") {
                fit = fit.max(0.70);
            }
        }
        "tests" => {
            if has("implementation") {
                fit = fit.max(0.60);
            }
            if has("bugfix") {
                fit = fit.max(0.65);
            }
            if has("integration") {
                fit = fit.max(0.70);
            }
        }
        "review" => {
            if has("contract") {
                fit = fit.max(0.80);
            }
            if has("security") {
                fit = fit.max(0.75);
            }
            if has("architecture") {
                fit = fit.max(0.70);
            }
        }
        "security" => {
            if has("review") {
                fit = fit.max(0.85);
            }
            if has("reasoning") {
                fit = fit.max(0.85);
            }
            if has("architecture") {
                fit = fit.max(0.75);
            }
        }
        "integration" => {
            if has("tests") {
                fit = fit.max(0.75);
            }
            if has("bugfix") {
                fit = fit.max(0.60);
            }
        }
        _ => {}
    }

    if has("fallback") {
        fit = fit.max(0.25);
    }

    fit.clamp(0.0, 1.0)
}

fn provider_fit(kind: &str, provider: &str, large_task: bool) -> f64 {
    let provider = provider.trim().to_ascii_lowercase();

    let is_claude = matches!(provider.as_str(), "claude" | "claude-code");
    let is_codex = provider == "codex";
    let is_devin = provider == "devin";

    match kind {
        "architecture" | "reasoning" | "security" => {
            if is_claude {
                1.0
            } else if is_codex {
                0.75
            } else if is_devin {
                0.45
            } else {
                0.50
            }
        }

        "feature" => {
            if large_task {
                if is_devin {
                    1.0
                } else if is_codex {
                    0.95
                } else if is_claude {
                    0.85
                } else {
                    0.50
                }
            } else if is_codex {
                1.0
            } else if is_devin {
                0.95
            } else if is_claude {
                0.85
            } else {
                0.50
            }
        }

        "bugfix" => {
            if is_claude {
                1.0
            } else if is_codex {
                0.95
            } else if is_devin {
                0.75
            } else {
                0.50
            }
        }

        "iteration" | "integration" => {
            if is_codex {
                1.0
            } else if is_claude {
                0.75
            } else if is_devin {
                0.65
            } else {
                0.50
            }
        }

        "refactor" => {
            if large_task {
                if is_devin {
                    1.0
                } else if is_codex {
                    0.95
                } else if is_claude {
                    0.85
                } else {
                    0.50
                }
            } else if is_codex {
                1.0
            } else if is_devin {
                0.90
            } else if is_claude {
                0.85
            } else {
                0.50
            }
        }

        "migration" => {
            if is_devin {
                1.0
            } else if is_claude {
                0.85
            } else if is_codex {
                0.80
            } else {
                0.50
            }
        }

        "dependency_upgrade" => {
            if is_devin {
                1.0
            } else if is_codex {
                0.90
            } else if is_claude {
                0.70
            } else {
                0.50
            }
        }

        "tests" => {
            if is_codex {
                1.0
            } else if is_devin {
                0.90
            } else if is_claude {
                0.75
            } else {
                0.50
            }
        }

        "review" => {
            if is_claude || is_codex {
                1.0
            } else {
                0.50
            }
        }

        _ => 0.50,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct RoutingGolden {
        version: String,
        cases: Vec<RoutingGoldenCase>,
    }

    #[derive(Deserialize)]
    struct RoutingGoldenCase {
        name: String,
        task: RoutingTaskProfile,
        candidates: Vec<CandidateRoutingSignals>,
        expected: RoutingGoldenExpected,
    }

    #[derive(Deserialize)]
    struct RoutingGoldenExpected {
        preferred_worker: Option<String>,
        selected_worker: Option<String>,
        preferred_score: Option<f64>,
        selected_score: Option<f64>,
        candidate_names: Vec<String>,
        selected_eligible: Vec<bool>,
    }

    #[test]
    fn shared_worker_routing_golden_exercises_the_actual_rust_scorer() {
        let golden: RoutingGolden = serde_json::from_str(include_str!(
            "../../../tests/fixtures/amux-worker-routing-v1.json"
        ))
        .unwrap();
        assert_eq!(golden.version, "amux-worker-router-v1");
        for case in golden.cases {
            let score = score_execute_candidates(&case.task, &case.candidates);
            assert_eq!(
                score.preferred_worker, case.expected.preferred_worker,
                "{}",
                case.name
            );
            assert_eq!(
                score.selected_worker, case.expected.selected_worker,
                "{}",
                case.name
            );
            assert_eq!(
                score
                    .candidates
                    .iter()
                    .map(|row| row.worker_name.clone())
                    .collect::<Vec<_>>(),
                case.expected.candidate_names,
                "{}",
                case.name
            );
            assert_eq!(
                score
                    .candidates
                    .iter()
                    .map(|row| row.breakdown.selected_eligible)
                    .collect::<Vec<_>>(),
                case.expected.selected_eligible,
                "{}",
                case.name
            );
            for (actual, expected) in [
                (score.preferred_score, case.expected.preferred_score),
                (score.selected_score, case.expected.selected_score),
            ] {
                if let Some(expected) = expected {
                    assert!((actual.unwrap() - expected).abs() < 1e-12, "{}", case.name);
                }
            }
        }
    }

    fn worker(name: &str, provider: &str, roles: &[&str]) -> RoutingWorkerCandidate {
        RoutingWorkerCandidate {
            worker_name: name.to_string(),
            provider: provider.to_string(),
            model: None,
            routing_roles: roles.iter().map(|role| (*role).to_string()).collect(),
            running: true,
            status: "idle".into(),
            dispatch_ready: true,
            archived: false,
            paused: false,
            isolated: false,
            blocked: false,
        }
    }

    fn signals(worker: RoutingWorkerCandidate) -> CandidateRoutingSignals {
        CandidateRoutingSignals {
            worker,
            predicted_success: None,
            quota_remaining: None,
            expected_speed: None,
            low_rework: None,
            low_human_attention: None,
            cost_efficiency: None,
            provider_exhausted: false,
        }
    }

    fn task(kind: &str, complexity: i64) -> RoutingTaskProfile {
        RoutingTaskProfile {
            task_kind: kind.to_string(),
            complexity,
            risk: 1,
            files_expected: None,
        }
    }

    #[test]
    fn preferred_preserves_devin_demand_when_devin_is_exhausted() {
        let mut devin = signals(worker(
            "devin-worker",
            "devin",
            &["migration", "multi_file"],
        ));
        devin.provider_exhausted = true;
        devin.quota_remaining = Some(0.0);

        let codex = signals(worker("codex-impl", "codex", &["implementation"]));

        let result = score_execute_candidates(&task("migration", 8), &[devin, codex]);

        assert_eq!(result.preferred_worker.as_deref(), Some("devin-worker"));
        assert_eq!(result.selected_worker.as_deref(), Some("codex-impl"));
    }

    #[test]
    fn missing_evidence_is_an_explicit_neutral_prior() {
        let result = score_execute_candidates(
            &task("feature", 4),
            &[signals(worker(
                "codex-impl",
                "codex",
                &["feature", "implementation"],
            ))],
        );

        let breakdown = &result.candidates[0].breakdown;

        assert_eq!(
            breakdown.predicted_success,
            MetricBreakdown {
                value: 0.5,
                observed: false,
            }
        );

        assert_eq!(
            breakdown.quota_remaining,
            MetricBreakdown {
                value: 0.5,
                observed: false,
            }
        );
    }

    #[test]
    fn worker_name_is_not_a_capability_signal() {
        let a = signals(worker(
            "anything-a",
            "codex",
            &["feature", "implementation"],
        ));
        let b = signals(worker(
            "anything-b",
            "codex",
            &["feature", "implementation"],
        ));

        let result = score_execute_candidates(&task("feature", 4), &[b, a]);

        assert_eq!(
            result.candidates[0].breakdown.task_fit,
            result.candidates[1].breakdown.task_fit
        );

        // Equal scores use worker name only as a deterministic final tie-break.
        assert_eq!(result.selected_worker.as_deref(), Some("anything-a"));
    }

    #[test]
    fn selected_score_uses_the_declared_weights_exactly() {
        let mut candidate = signals(worker("codex-impl", "codex", &["feature"]));

        candidate.predicted_success = Some(0.8);
        candidate.quota_remaining = Some(0.7);
        candidate.expected_speed = Some(0.6);
        candidate.low_rework = Some(0.9);
        candidate.low_human_attention = Some(0.4);
        candidate.cost_efficiency = Some(0.5);

        let result = score_execute_candidates(&task("feature", 4), &[candidate]);

        let breakdown = &result.candidates[0].breakdown;

        assert_eq!(breakdown.task_fit.combined, 1.0);

        let expected = 0.30 * 1.0
            + 0.20 * 0.8
            + 0.20 * 0.7
            + 0.10 * 0.6
            + 0.10 * 0.9
            + 0.05 * 0.4
            + 0.05 * 0.5;

        assert!(
            (breakdown.selected_score - expected).abs() < 1e-12,
            "{} != {}",
            breakdown.selected_score,
            expected
        );
    }

    #[test]
    fn idle_without_a_recognized_boundary_is_not_selected() {
        let mut unsafe_idle = signals(worker(
            "devin-worker",
            "devin",
            &["implementation", "bugfix"],
        ));

        unsafe_idle.worker.running = true;
        unsafe_idle.worker.status = "idle".into();
        unsafe_idle.worker.dispatch_ready = false;

        let mut ready = signals(worker("codex-impl", "codex", &["implementation", "bugfix"]));
        ready.worker.dispatch_ready = true;
        ready.quota_remaining = Some(0.24);

        let result = score_execute_candidates(&task("bugfix", 4), &[unsafe_idle, ready]);

        assert_eq!(result.selected_worker.as_deref(), Some("codex-impl"));

        let devin = result
            .candidates
            .iter()
            .find(|candidate| candidate.worker_name == "devin-worker")
            .unwrap();

        assert!(devin.breakdown.operationally_allowed);
        assert!(!devin.breakdown.selected_eligible);
    }

    #[test]
    fn stopped_worker_remains_selectable_for_start_for_dispatch() {
        let mut stopped = signals(worker(
            "devin-worker",
            "devin",
            &["migration", "multi_file"],
        ));

        stopped.worker.running = false;
        stopped.worker.status = "stopped".into();
        stopped.worker.dispatch_ready = false;

        let result = score_execute_candidates(&task("migration", 8), &[stopped]);

        assert_eq!(result.selected_worker.as_deref(), Some("devin-worker"));
    }

    #[test]
    fn operator_disabled_worker_is_not_selected_or_preferred() {
        let mut disabled = signals(worker("claude-disabled", "claude", &["architecture"]));
        disabled.worker.paused = true;

        let fallback = signals(worker("codex-contract", "codex", &["architecture"]));

        let result = score_execute_candidates(&task("architecture", 5), &[disabled, fallback]);

        assert_eq!(result.preferred_worker.as_deref(), Some("codex-contract"));
        assert_eq!(result.selected_worker.as_deref(), Some("codex-contract"));
    }
}
