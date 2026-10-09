//! Intelligent-routing worker catalog.
//!
//! This is deliberately separate from `provider::routing`: provider routing is
//! the capacity/failover safety gate, while this module describes the workers
//! that task-fit routing may consider.
//!
//! A legacy session opts into intelligent routing only by declaring
//! `CC_ROUTING_ROLES`. Worker names are identity only; they are never interpreted
//! as capabilities.

use crate::api::session_verbs::{
    configured_model_with_default, is_session_blocked, parse_env, provider_of,
    routing_roles_from_cfg, session_is_isolated,
};
use crate::api::sessions_legacy::FleetSignals;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct RoutingWorkerCandidate {
    pub worker_name: String,
    pub provider: String,

    /// Explicitly configured model only.
    ///
    /// `None` means AMUX has no explicit model fact for this worker. The task
    /// router must not invent a provider default.
    pub model: Option<String>,

    /// Explicit capability/specialization metadata from `CC_ROUTING_ROLES`.
    pub routing_roles: Vec<String>,

    /// Does a live agent currently exist in the worker's tmux lane?
    pub running: bool,

    /// Display/runtime status derived from the fleet's shared status truth.
    /// Stopped workers are normalized to `stopped`.
    pub status: String,

    /// Positive evidence that input may be delivered now.
    ///
    /// Displaying `idle` is not sufficient: FleetSignals must recognize a real
    /// turn boundary, and lifecycle/safety gates must also be open.
    pub dispatch_ready: bool,

    pub archived: bool,
    pub paused: bool,
    pub isolated: bool,
    pub blocked: bool,
}

/// Build the intelligent-routing candidate catalog from an already captured
/// fleet snapshot.
///
/// The caller supplies `FleetSignals` so routing and the rest of AMUX consume
/// the same liveness snapshot. This function intentionally does not perform its
/// own tmux/DB status probe.
///
/// Sessions without `CC_ROUTING_ROLES` are not routing candidates. Unavailable
/// workers remain visible in the catalog so later routing can distinguish
/// capability/preference from current execution availability.
pub(crate) fn catalog_from_signals(
    signals: &FleetSignals,
) -> Vec<RoutingWorkerCandidate> {
    let sessions_dir = crate::config::amux_home().join("sessions");

    let Ok(entries) = std::fs::read_dir(&sessions_dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();

        if path.extension().and_then(|v| v.to_str()) != Some("env") {
            continue;
        }

        let Some(name) = path
            .file_stem()
            .and_then(|v| v.to_str())
            .map(str::to_string)
        else {
            continue;
        };

        let cfg = parse_env(&name);
        let routing_roles = routing_roles_from_cfg(&cfg);

        // Explicit opt-in. Never infer routing capability from the lane name.
        if routing_roles.is_empty() {
            continue;
        }

        let provider = provider_of(&cfg);
        let cc_model = cfg.get("CC_MODEL").unwrap_or("");
        let cc_flags = cfg.get("CC_FLAGS").unwrap_or("");

        // Empty default is intentional: the router needs an observed/configured
        // model fact, not an assumed provider default.
        let model = configured_model_with_default(
            &provider,
            cc_model,
            cc_flags,
            "",
        );
        let model = nonempty(model);

        let archived = cfg.get("CC_ARCHIVED") == Some("1");
        let paused = cfg.get("CC_PAUSED") == Some("1");
        let isolated = session_is_isolated(&name);
        let blocked = is_session_blocked(&name);

        let tmux_name = format!("amux-{name}");
        let running = signals.agent_running(&tmux_name);

        let raw_status = signals.derive_status(&name, running);
        let status = if raw_status.trim().is_empty() {
            "stopped".to_string()
        } else {
            raw_status
        };

        // Positive delivery evidence only. FleetSignals deliberately
        // distinguishes an idle-looking UI from a recognized terminal boundary.
        let idle_boundary =
            signals.turn_boundary_status(&name).as_deref() == Some("idle");

        out.push(finalize_candidate(
            name,
            provider,
            model,
            routing_roles,
            running,
            status,
            idle_boundary,
            archived,
            paused,
            isolated,
            blocked,
        ));
    }

    // Stable catalog order makes score traces and tests deterministic.
    out.sort_by(|a, b| a.worker_name.cmp(&b.worker_name));
    out
}

fn nonempty(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[allow(clippy::too_many_arguments)]
fn finalize_candidate(
    worker_name: String,
    provider: String,
    model: Option<String>,
    routing_roles: Vec<String>,
    running: bool,
    status: String,
    idle_boundary: bool,
    archived: bool,
    paused: bool,
    isolated: bool,
    blocked: bool,
) -> RoutingWorkerCandidate {
    let dispatch_ready = running
        && idle_boundary
        && !archived
        && !paused
        && !isolated
        && !blocked;

    RoutingWorkerCandidate {
        worker_name,
        provider,
        model,
        routing_roles,
        running,
        status,
        dispatch_ready,
        archived,
        paused,
        isolated,
        blocked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(
        running: bool,
        idle_boundary: bool,
        archived: bool,
        paused: bool,
        isolated: bool,
        blocked: bool,
    ) -> RoutingWorkerCandidate {
        finalize_candidate(
            "worker".to_string(),
            "claude".to_string(),
            Some("opus".to_string()),
            vec!["feature".to_string()],
            running,
            if running {
                "idle".to_string()
            } else {
                "stopped".to_string()
            },
            idle_boundary,
            archived,
            paused,
            isolated,
            blocked,
        )
    }

    #[test]
    fn dispatch_ready_requires_positive_idle_boundary_and_open_gates() {
        assert!(candidate(true, true, false, false, false, false).dispatch_ready);

        assert!(!candidate(true, false, false, false, false, false).dispatch_ready);
        assert!(!candidate(true, true, true, false, false, false).dispatch_ready);
        assert!(!candidate(true, true, false, true, false, false).dispatch_ready);
        assert!(!candidate(true, true, false, false, true, false).dispatch_ready);
        assert!(!candidate(true, true, false, false, false, true).dispatch_ready);
    }

    #[test]
    fn stopped_worker_remains_describable_but_is_not_dispatch_ready() {
        let c = candidate(false, true, false, false, false, false);

        assert_eq!(c.worker_name, "worker");
        assert_eq!(c.provider, "claude");
        assert_eq!(c.model.as_deref(), Some("opus"));
        assert_eq!(c.routing_roles, vec!["feature"]);
        assert_eq!(c.status, "stopped");
        assert!(!c.running);
        assert!(!c.dispatch_ready);
    }

    #[test]
    fn empty_model_is_unknown_not_an_invented_default() {
        assert_eq!(nonempty(String::new()), None);
        assert_eq!(nonempty("   ".to_string()), None);
        assert_eq!(
            nonempty(" gpt-5.6-sol ".to_string()).as_deref(),
            Some("gpt-5.6-sol")
        );
    }
}
