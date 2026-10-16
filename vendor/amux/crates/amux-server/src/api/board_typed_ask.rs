//! `GET /api/board/{id}/typed-ask`: what the Decision Maker side of a typed
//! ask holds for a card (crate::db::dm_ask, docs/policy/amux-decision-maker.md).
//!
//! Read-only on purpose. A worker writes its typed ask through the ordinary
//! board create and PATCH (`typed_ask` beside `ask_type`/`ask_question`/
//! `ask_unblocks`); this answers what was recorded: the extension as stored,
//! with each effect declaration as recorded, the card's current question
//! revision, and the DM-pending marker and answer record of that revision.
//! Setting or releasing the marker and claiming the answer record get their
//! HTTP verbs with their callers, outside `/api/board`, because the bridge
//! that will call them never posts to `/api/board`.

use super::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::OptionalExtension;
use serde_json::json;

pub async fn get_typed_ask(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let id_r = id.clone();
    let read = state
        .store
        .read_async(move |conn| {
            let exists = conn
                .query_row(
                    "SELECT 1 FROM issues WHERE id = ?1 AND deleted IS NULL",
                    [&id_r],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                return Ok(None);
            }
            Ok(Some(crate::db::dm_ask::state_json(conn, &id_r)?))
        })
        .await;
    match read {
        Ok(Some(body)) => Json(body).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "item not found", "id": id })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string(), "id": id })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use serde_json::Value;
    use std::sync::Arc;
    use tower::ServiceExt;

    const WORKER: &str = "dm-typed-ask-test-worker";

    fn app() -> (Router, crate::db::SharedStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::db::Store::open(&dir.path().join("typed-ask.db")).unwrap());
        // The writer and read pool outlive this helper.
        std::mem::forget(dir);
        let state = AppState {
            store: store.clone(),
            started: std::time::Instant::now(),
            build_hash: "test".into(),
            auth_token: None,
            reconciled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        };
        (
            Router::new()
                .nest("/api/board", crate::api::board::routes())
                .with_state(state),
            store,
        )
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("x-amux-session", WORKER);
        let payload = match body {
            Some(body) => {
                request = request.header("content-type", "application/json");
                axum::body::Body::from(body.to_string())
            }
            None => axum::body::Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(request.body(payload).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn asking(extra: Value) -> Value {
        let mut body = json!({
            "title": "Pick the index store",
            "status": "needsyou",
            "ask_actor": "Ethan",
            "ask_type": "decision",
            "ask_question": "Which store should the index use?",
            "ask_unblocks": "The owner names the store to use.",
        });
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    }

    fn options() -> Value {
        json!({
            "options": [
                {"id": "sqlite", "label": "Keep SQLite", "effect": "choice_only"},
                {"id": "pg", "label": "Move to Postgres", "effect": "branch_code_change",
                 "paths": ["crates/amux-server/src/db/mod.rs"]},
                {"id": "later", "label": "Decide next week", "effect": "deploy_now"}
            ],
            "resolution": "decision_only",
            "context": "The index grows by 40 MB a week.",
            "context_paths": ["docs/policy/amux-decision-maker.md"]
        })
    }

    fn revisions(store: &crate::db::SharedStore, id: &str) -> i64 {
        store
            .read()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM _amux_dm_ask_revisions WHERE issue_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn a_card_filed_asking_with_a_typed_ask_has_revision_one_as_recorded() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, _store) = app();
        let (status, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        // The response shows the extension as recorded: the undeclarable
        // effect became `other`, not a refusal.
        assert_eq!(
            created["typed_ask"]["options"][2]["effect"], "other",
            "{created}"
        );
        let id = created["id"].as_str().unwrap().to_string();

        let (status, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert_eq!(status, StatusCode::OK, "{state}");
        assert_eq!(state["current_revision"]["question_revision"], 1, "{state}");
        let detail = &state["current_revision"]["detail"];
        assert_eq!(detail["resolution"], "decision_only");
        assert_eq!(
            detail["options"][1]["paths"][0],
            "crates/amux-server/src/db/mod.rs"
        );
        assert_eq!(
            detail["context_paths"][0],
            "docs/policy/amux-decision-maker.md"
        );
        assert_eq!(
            state["current_revision"]["ask_question"],
            "Which store should the index use?"
        );
        assert!(
            state["pending"].is_null() && state["answer"].is_null(),
            "{state}"
        );
    }

    #[tokio::test]
    async fn an_existing_ask_without_a_typed_ask_still_works_and_gets_an_empty_extension() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, _store) = app();
        let (status, created) = call(&app, "POST", "/api/board", Some(asking(json!({})))).await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        assert!(
            created.get("typed_ask").is_none(),
            "nothing was sent, nothing is echoed"
        );
        let id = created["id"].as_str().unwrap();
        let (_, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert!(state["typed_ask"].is_null(), "{state}");
        assert_eq!(state["current_revision"]["question_revision"], 1, "{state}");
        assert_eq!(state["current_revision"]["detail"]["options"], json!([]));
    }

    #[tokio::test]
    async fn a_patch_carrying_only_typed_ask_is_applied_and_recorded_on_the_card() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, store) = app();
        let (_, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let rev_before = created["rev"].as_i64().unwrap();

        let narrower =
            json!({"options": [{"id": "sqlite", "label": "Keep SQLite", "effect": "choice_only"}]});
        let (status, patched) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"typed_ask": narrower})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(
            patched["applied"], true,
            "a typed_ask-only PATCH is not a no-op: {patched}"
        );
        assert!(patched["rev"].as_i64().unwrap() > rev_before);
        assert!(
            patched["log"].as_str().unwrap_or("").contains("typed_ask"),
            "the card's own history names the change"
        );
        assert_eq!(revisions(&store, &id), 2);

        // The same extension again changes nothing.
        let (status, again) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"typed_ask": narrower})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(again["applied"], false, "{again}");
        assert_eq!(revisions(&store, &id), 2);
    }

    #[tokio::test]
    async fn re_asking_without_typed_ask_drops_the_previous_options() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, store) = app();
        let (_, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (status, patched) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"ask_question": "Should the index be dropped instead?"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(revisions(&store, &id), 2);
        let (_, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert_eq!(state["current_revision"]["question_revision"], 2, "{state}");
        assert_eq!(
            state["current_revision"]["detail"]["options"],
            json!([]),
            "{state}"
        );
        assert_eq!(
            state["current_revision"]["ask_question"],
            "Should the index be dropped instead?"
        );

        // Re-sending the very same extension is what attaches it to the new
        // question, so it is a change, not a no-op.
        let (status, reattached) = call(
            &app,
            "PATCH",
            &format!("/api/board/{id}"),
            Some(json!({"typed_ask": options()})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{reattached}");
        assert_eq!(reattached["applied"], true, "{reattached}");
        assert_eq!(revisions(&store, &id), 3);
        let (_, state) = call(&app, "GET", &format!("/api/board/{id}/typed-ask"), None).await;
        assert_eq!(state["current_revision"]["question_revision"], 3, "{state}");
        assert_eq!(
            state["current_revision"]["detail"]["options"][0]["id"], "sqlite",
            "{state}"
        );
        assert_eq!(
            state["current_revision"]["ask_question"],
            "Should the index be dropped instead?"
        );
    }

    #[tokio::test]
    async fn a_malformed_typed_ask_refuses_the_whole_patch_and_writes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, store) = app();
        let (_, created) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": options()}))),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (_, before) = call(&app, "GET", &format!("/api/board/{id}"), None).await;

        for (bad, code) in [
            (
                json!({"options": [{"id": "has space", "label": "x"}]}),
                "typed_ask_option_id",
            ),
            (json!({"resolution": "maybe"}), "typed_ask_resolution"),
            (json!({"context_paths": ["../outside"]}), "typed_ask_path"),
            (json!({"contextPaths": []}), "typed_ask_unknown_field"),
        ] {
            let (status, refused) = call(
                &app,
                "PATCH",
                &format!("/api/board/{id}"),
                Some(json!({"typed_ask": bad, "desc_append": "this must not land"})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
            assert_eq!(refused["code"], code, "{refused}");
        }
        let (_, after) = call(&app, "GET", &format!("/api/board/{id}"), None).await;
        assert_eq!(after["rev"], before["rev"]);
        assert_eq!(after["desc"], before["desc"]);
        assert_eq!(revisions(&store, &id), 1);

        let (status, refused) = call(
            &app,
            "POST",
            "/api/board",
            Some(asking(json!({"typed_ask": {"options": [{"id": "a", "label": "x"}, {"id": "a", "label": "y"}]}}))),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["code"], "typed_ask_option_id_repeated");
    }

    #[tokio::test]
    async fn an_unknown_card_is_404() {
        let home = tempfile::tempdir().unwrap();
        let _home = crate::api::settings::test_env::set_home(home.path());
        let (app, _store) = app();
        let (status, body) = call(&app, "GET", "/api/board/NOPE-404/typed-ask", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }
}
