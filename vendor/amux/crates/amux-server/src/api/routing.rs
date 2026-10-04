//! Read-only intelligent-routing diagnostics.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use super::AppState;

/// Return the worker catalog consumed by intelligent task routing.
///
/// This endpoint is diagnostic/read-only. It uses the same measured
/// `FleetSignals` snapshot and delivery-boundary derivation as the existing
/// session/steering paths rather than probing tmux independently.
pub(crate) async fn workers(State(state): State<AppState>) -> Response {
    let Some(signals) =
        crate::api::session_verbs::boundary_signals(&state, None).await
    else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "measured": false,
                "count": 0,
                "workers": [],
                "error": "fleet signals unavailable"
            })),
        )
            .into_response();
    };

    let workers = crate::worker_catalog::catalog_from_signals(&signals);
    let count = workers.len();

    (
        StatusCode::OK,
        Json(json!({
            "measured": true,
            "count": count,
            "workers": workers
        })),
    )
        .into_response()
}
