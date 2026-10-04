#!/usr/bin/env python3
"""Extract a completed Codex CLI attempt's reported usage without prompt text."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from datetime import datetime

TOKEN_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
)
ATTEMPT_MARKER = re.compile(r"Execution attempt: ([0-9a-f-]{36})")


def extract_usage(rollout, attempt_id, task_id, turn_ids, worker, card_id, closed_at):
    closed_time = datetime.fromisoformat(closed_at.replace('Z', '+00:00'))
    if not turn_ids or len(set(turn_ids)) != len(turn_ids):
        raise ValueError("unique ordered turn IDs required")
    selected = set(turn_ids)
    active_turn = None
    completed = []
    markers = {turn_id: 0 for turn_id in turn_ids}
    samples = {turn_id: 0 for turn_id in turn_ids}
    totals = {key: 0 for key in TOKEN_KEYS}
    source_digest = hashlib.sha256()
    session_id = None
    cli_version = None
    provider = None
    model = None
    started_at = None
    ended_at = None
    scope_started = False

    for raw in rollout:
        row = json.loads(raw)
        timestamp = row.get("timestamp", "")
        payload = row.get("payload") or {}
        kind = payload.get("type")
        if row.get("type") == "session_meta":
            session_id = payload.get("id")
            cli_version = payload.get("cli_version")
            provider = payload.get("model_provider")

        if row.get("type") == "event_msg" and kind == "task_started":
            turn = payload.get("turn_id")
            if turn == turn_ids[0] and not scope_started:
                scope_started = True
                started_at = timestamp
            if scope_started and datetime.fromisoformat(timestamp.replace('Z', '+00:00')) < closed_time:
                if turn not in selected or turn in completed or active_turn is not None:
                    raise ValueError("unselected, duplicate or overlapping turn before card closure")
                if turn != turn_ids[len(completed)]:
                    raise ValueError("selected turns out of order")
                active_turn = turn
                source_digest.update(raw.encode())
            continue

        if not active_turn:
            continue
        source_digest.update(raw.encode())
        if row.get("type") == "turn_context" and payload.get("turn_id") == active_turn:
            observed_model = payload.get("model")
            if model and model != observed_model:
                raise ValueError("model changed within attempt")
            model = observed_model
        elif row.get("type") == "response_item" and kind == "message":
            metadata = payload.get("internal_chat_message_metadata_passthrough") or {}
            if payload.get("role") == "user" and metadata.get("turn_id") == active_turn:
                encoded = json.dumps(payload.get("content"), ensure_ascii=False)
                attempts = ATTEMPT_MARKER.findall(encoded)
                if any(value != attempt_id for value in attempts):
                    raise ValueError("another execution attempt appears in selected turn")
                if active_turn == turn_ids[0]:
                    if attempts:
                        if f"Task: {task_id}" not in encoded:
                            raise ValueError("attempt marker has a different task")
                        markers[active_turn] += 1
                elif re.search(rf"(?<![A-Z0-9-]){re.escape(card_id)}(?![A-Z0-9-])", encoded):
                    markers[active_turn] += 1
        elif row.get("type") == "event_msg" and kind == "token_count":
            usage = (payload.get("info") or {}).get("last_token_usage")
            if not isinstance(usage, dict):
                raise ValueError("missing last-token usage")
            for key in TOKEN_KEYS:
                value = usage.get(key)
                if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                    raise ValueError(f"invalid {key}")
                totals[key] += value
            if usage.get("total_tokens") != usage["input_tokens"] + usage["output_tokens"]:
                raise ValueError("token total mismatch")
            if usage["cached_input_tokens"] > usage["input_tokens"]:
                raise ValueError("cached input exceeds input")
            if usage["reasoning_output_tokens"] > usage["output_tokens"]:
                raise ValueError("reasoning output exceeds output")
            samples[active_turn] += 1
        elif row.get("type") == "event_msg" and kind == "task_complete":
            if payload.get("turn_id") != active_turn:
                raise ValueError("another turn completed inside selected turn")
            ended_at = timestamp
            if datetime.fromisoformat(ended_at.replace('Z', '+00:00')) >= closed_time:
                raise ValueError("turn ended after card closure")
            completed.append(active_turn)
            active_turn = None

    if active_turn or completed != turn_ids:
        raise ValueError("all selected turns must complete before card closure")
    if any(markers[turn] != 1 or samples[turn] == 0 for turn in turn_ids):
        raise ValueError("each turn needs one binding marker and usage samples")
    if not session_id or not cli_version or provider != "openai" or not model:
        raise ValueError("session, CLI version, provider and model required")
    return {
        "schemaVersion": 1,
        "source": "codex_cli_last_token_usage",
        "attemptId": attempt_id,
        "taskId": task_id,
        "worker": worker,
        "cardId": card_id,
        "sessionId": session_id,
        "turnIds": turn_ids,
        "provider": provider,
        "model": model,
        "cliVersion": cli_version,
        "startedAt": started_at,
        "endedAt": ended_at,
        "cardClosedAt": closed_at,
        "usage": {
            "inputTokens": totals["input_tokens"],
            "cachedInputTokens": totals["cached_input_tokens"],
            "cacheWriteInputTokens": totals["cache_write_input_tokens"],
            "outputTokens": totals["output_tokens"],
            "reasoningOutputTokens": totals["reasoning_output_tokens"],
        },
        "usageSamples": sum(samples.values()),
        "sourceSpanSha256": source_digest.hexdigest(),
        "actualBilledCostMicrousd": None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rollout", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--turn", action="append", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--card", required=True)
    parser.add_argument("--closed-at", required=True)
    args = parser.parse_args()
    with args.rollout.open(encoding="utf-8") as stream:
        receipt = extract_usage(
            stream, args.attempt, args.task, args.turn, args.worker, args.card,
            args.closed_at
        )
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
