/**
 * Local AMUX card as the execution receipt (policy version 15).
 *
 * Local AMUX refuses `no_board` for substantive work and mints a card for the
 * message it delivers (AMUX-3071). That card is the attempt's local record;
 * Tomverse stays the source of truth. The bridge only reads the local board:
 * `GET /api/board` and `GET /api/board/{id}`. Everything a card says (title,
 * description, `last_result`, evidence) is untrusted input and is never copied
 * to Tomverse, except one review PR number of a fixed URL shape, which the
 * server verifies by reading GitHub itself.
 */
use serde_json::Value;

/// How long a delivered attempt may stay without a linked local card.
pub const LOCAL_CARD_LINK_WINDOW_SECS: i64 = 30 * 60;

/// Tolerance between the workstation clock the bridge reads and the local
/// AMUX clock that stamps `created`. Both are the same machine; this only
/// absorbs second rounding.
pub const LOCAL_CARD_CREATED_SKEW_SECS: i64 = 60;

const REVIEW_PR_PREFIX: &str = "https://github.com/mposition/Tomverse/pull/";
const REVIEW_PR_MAX: i64 = 2_147_483_647;

/// The line the Tomverse delivery prompt carries (`lib/amux/deliveryPrompt.ts`).
pub fn attempt_marker(attempt_id: &str) -> String {
    format!("Execution attempt: {attempt_id}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCardSummary {
    pub id: String,
    pub session: Option<String>,
    pub created: i64,
    pub archived: bool,
}

/// A local card id that may be placed in a URL path.
pub fn valid_local_card_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn parse_board_list(body: &Value) -> Vec<LocalCardSummary> {
    let Some(rows) = body.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?;
            if !valid_local_card_id(id) {
                return None;
            }
            let archived = match row.get("archived") {
                Some(Value::Bool(value)) => *value,
                Some(Value::Number(value)) => value.as_i64().unwrap_or(1) != 0,
                _ => false,
            };
            Some(LocalCardSummary {
                id: id.to_owned(),
                session: row
                    .get("session")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                created: row.get("created").and_then(Value::as_i64).unwrap_or(0),
                archived,
            })
        })
        .collect()
}

/// Cards that could be this attempt's receipt: the same worker session, not
/// archived, created no earlier than the send, oldest first. The receipt is
/// minted right after the send, so it sits at the front however many cards the
/// session makes later, and a caller that opens only the first few still
/// reaches it.
pub fn candidate_card_ids(cards: &[LocalCardSummary], worker: &str, sent_at: i64) -> Vec<String> {
    let mut candidates: Vec<&LocalCardSummary> = cards
        .iter()
        .filter(|card| {
            !card.archived
                && card.session.as_deref() == Some(worker)
                && card.created >= sent_at - LOCAL_CARD_CREATED_SKEW_SECS
        })
        .collect();
    candidates.sort_by(|left, right| left.created.cmp(&right.created).then(left.id.cmp(&right.id)));
    candidates.into_iter().map(|card| card.id.clone()).collect()
}

/// Whether a card's own linked message carries this attempt's marker line.
///
/// A child card displays its epic's messages, so a message counts only when
/// its `card_id` is this card: otherwise an epic and each of its children
/// would all match and the link would be ambiguous.
pub fn card_links_attempt(detail: &Value, attempt_id: &str) -> bool {
    let Some(card_id) = detail.get("id").and_then(Value::as_str) else {
        return false;
    };
    let marker = attempt_marker(attempt_id);
    detail
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages.iter().any(|message| {
                message.get("card_id").and_then(Value::as_str) == Some(card_id)
                    && message
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| text.lines().any(|line| line.trim() == marker))
            })
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkDecision {
    Linked(String),
    Ambiguous,
    Waiting,
    Unlinked,
}

pub fn decide_link(matches: Vec<String>, sent_at: i64, now: i64) -> LinkDecision {
    match matches.len() {
        1 => LinkDecision::Linked(matches.into_iter().next().unwrap_or_default()),
        0 if now - sent_at >= LOCAL_CARD_LINK_WINDOW_SECS => LinkDecision::Unlinked,
        0 => LinkDecision::Waiting,
        _ => LinkDecision::Ambiguous,
    }
}

/// The Tomverse settlement a linked card's status means, if it is terminal.
/// A local failure never becomes `failed -> todo`; a retry is a human review
/// decision.
pub fn local_card_outcome(status: &str) -> Option<(&'static str, &'static str)> {
    match status {
        "done" | "verified" => Some(("succeeded", "review")),
        "discarded" | "cancelled" | "quarantined" => Some(("blocked", "blocked")),
        _ => None,
    }
}

/// The first `https://github.com/mposition/Tomverse/pull/<n>` number in the
/// given texts, in order. Nothing else from the texts is used.
pub fn review_pr_number_from(texts: &[&str]) -> Option<i64> {
    for text in texts {
        let mut rest = *text;
        while let Some(index) = rest.find(REVIEW_PR_PREFIX) {
            let tail = &rest[index + REVIEW_PR_PREFIX.len()..];
            let digits: String = tail.chars().take_while(char::is_ascii_digit).take(11).collect();
            let boundary_ok = tail
                .chars()
                .nth(digits.len())
                .is_none_or(|next| !next.is_ascii_alphanumeric());
            if !digits.is_empty() && digits.len() <= 10 && boundary_ok {
                if let Ok(number) = digits.parse::<i64>() {
                    if (1..=REVIEW_PR_MAX).contains(&number) {
                        return Some(number);
                    }
                }
            }
            rest = tail;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ATTEMPT: &str = "4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f";

    #[test]
    fn candidates_are_the_same_session_unarchived_and_not_older_than_the_send() {
        let cards = parse_board_list(&json!([
            {"id": "AMUX-1", "session": "claude-impl", "created": 1000, "archived": 0},
            {"id": "AMUX-2", "session": "claude-impl", "created": 930, "archived": 0},
            {"id": "AMUX-3", "session": "claude-impl", "created": 2000, "archived": 1},
            {"id": "AMUX-4", "session": "codex-impl", "created": 2000, "archived": 0},
            {"id": "bad/id", "session": "claude-impl", "created": 2000, "archived": 0},
            {"id": "AMUX-5", "session": "claude-impl", "created": 950, "archived": false}
        ]));
        assert_eq!(candidate_card_ids(&cards, "claude-impl", 1000), vec!["AMUX-5", "AMUX-1"]);
    }

    #[test]
    fn only_the_cards_own_message_with_the_exact_marker_line_links() {
        let own = json!({"id": "AMUX-7", "messages": [
            {"card_id": "AMUX-7", "text": format!("[Tomverse AMUX work]\nExecution attempt: {ATTEMPT}\n")}
        ]});
        let inherited = json!({"id": "AMUX-8", "epic": "AMUX-7", "messages": [
            {"card_id": "AMUX-7", "text": format!("Execution attempt: {ATTEMPT}")}
        ]});
        let other = json!({"id": "AMUX-9", "messages": [
            {"card_id": "AMUX-9", "text": "Execution attempt: 00000000-0000-4000-8000-000000000000"}
        ]});
        let prefix_only = json!({"id": "AMUX-10", "messages": [
            {"card_id": "AMUX-10", "text": format!("see Execution attempt: {ATTEMPT} above")}
        ]});
        assert!(card_links_attempt(&own, ATTEMPT));
        assert!(!card_links_attempt(&inherited, ATTEMPT));
        assert!(!card_links_attempt(&other, ATTEMPT));
        assert!(!card_links_attempt(&prefix_only, ATTEMPT));
        assert!(!card_links_attempt(&json!({"id": "AMUX-11", "messages": null}), ATTEMPT));
    }

    #[test]
    fn link_decision_waits_thirty_minutes_then_blocks_and_never_picks_between_two() {
        assert_eq!(decide_link(vec!["A".into()], 0, 5), LinkDecision::Linked("A".into()));
        assert_eq!(decide_link(vec![], 0, LOCAL_CARD_LINK_WINDOW_SECS - 1), LinkDecision::Waiting);
        assert_eq!(decide_link(vec![], 0, LOCAL_CARD_LINK_WINDOW_SECS), LinkDecision::Unlinked);
        assert_eq!(decide_link(vec!["A".into(), "B".into()], 0, 5), LinkDecision::Ambiguous);
    }

    #[test]
    fn terminal_statuses_map_to_review_or_blocked_and_nothing_to_todo() {
        assert_eq!(local_card_outcome("done"), Some(("succeeded", "review")));
        assert_eq!(local_card_outcome("verified"), Some(("succeeded", "review")));
        for status in ["discarded", "cancelled", "quarantined"] {
            assert_eq!(local_card_outcome(status), Some(("blocked", "blocked")));
        }
        for status in ["todo", "doing", "needsyou", "review", "", "failed"] {
            assert_eq!(local_card_outcome(status), None, "{status}");
        }
    }

    #[test]
    fn only_a_tomverse_pull_url_yields_a_review_pr_number() {
        assert_eq!(
            review_pr_number_from(&["opened https://github.com/mposition/Tomverse/pull/1733 for review"]),
            Some(1733)
        );
        assert_eq!(
            review_pr_number_from(&["", "https://github.com/mposition/Tomverse/pull/12/files"]),
            Some(12)
        );
        assert_eq!(review_pr_number_from(&["PR #1733", "https://github.com/other/Tomverse/pull/5"]), None);
        assert_eq!(review_pr_number_from(&["https://github.com/mposition/Tomverse/pull/0"]), None);
        assert_eq!(review_pr_number_from(&["https://github.com/mposition/Tomverse/pull/12abc"]), None);
        assert_eq!(review_pr_number_from(&["https://github.com/mposition/Tomverse/pull/99999999999"]), None);
        assert_eq!(
            review_pr_number_from(&[
                "https://github.com/mposition/Tomverse/pull/x then https://github.com/mposition/Tomverse/pull/40"
            ]),
            Some(40)
        );
    }

    #[test]
    fn local_card_ids_outside_the_path_alphabet_are_refused() {
        assert!(valid_local_card_id("AMUX-24"));
        assert!(valid_local_card_id("CC_58"));
        for id in ["", "a/b", "..", "a?b", "a b", &"x".repeat(65)] {
            assert!(!valid_local_card_id(id), "{id}");
        }
    }
}
