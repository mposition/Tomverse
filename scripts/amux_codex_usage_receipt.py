#!/usr/bin/env python3
"""Extract a completed Codex CLI attempt's reported usage without prompt text."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from datetime import datetime

REQUIRED_TOKEN_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
)
OPTIONAL_TOKEN_KEYS = ("cache_write_input_tokens",)
TOKEN_KEYS = REQUIRED_TOKEN_KEYS + OPTIONAL_TOKEN_KEYS
ATTEMPT_MARKER = re.compile(r"Execution attempt: ([0-9a-fA-F-]{36})")


def parse_timestamp(value):
    if not isinstance(value, str):
        raise ValueError("rollout timestamp needs an ISO string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("rollout timestamp needs a timezone")
    return parsed


def parse_usage(value):
    if not isinstance(value, dict):
        raise ValueError("missing token usage")
    result = {}
    for key in TOKEN_KEYS:
        number = value.get(key)
        if key in OPTIONAL_TOKEN_KEYS and number is None:
            result[key] = None
            continue
        if not isinstance(number, int) or isinstance(number, bool) or number < 0:
            raise ValueError(f"invalid {key}")
        result[key] = number
    if value.get("total_tokens") != result["input_tokens"] + result["output_tokens"]:
        raise ValueError("token total mismatch")
    if result["cached_input_tokens"] > result["input_tokens"]:
        raise ValueError("cached input exceeds input")
    if result["reasoning_output_tokens"] > result["output_tokens"]:
        raise ValueError("reasoning output exceeds output")
    return result


def extract_usage(rollout, attempt_id, task_id, turn_ids, worker, card_id, closed_at):
    closed_time = datetime.fromisoformat(closed_at.replace('Z', '+00:00'))
    if closed_time.tzinfo is None:
        raise ValueError("card closure time needs a timezone")
    if not turn_ids or len(set(turn_ids)) != len(turn_ids):
        raise ValueError("unique ordered turn IDs required")
    selected = set(turn_ids)
    active_turn = None
    completed = []
    markers = {turn_id: 0 for turn_id in turn_ids}
    samples = {turn_id: 0 for turn_id in turn_ids}
    totals = {key: 0 for key in TOKEN_KEYS}
    previous_cumulative = None
    previous_cumulative_raw = None
    baseline_digest = None
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
            if scope_started and parse_timestamp(timestamp) < closed_time:
                if turn not in selected or turn in completed or active_turn is not None:
                    raise ValueError("unselected, duplicate or overlapping turn before card closure")
                if turn != turn_ids[len(completed)]:
                    raise ValueError("selected turns out of order")
                active_turn = turn
                if not completed and previous_cumulative_raw is not None:
                    baseline_digest = hashlib.sha256(previous_cumulative_raw.encode()).hexdigest()
                source_digest.update(raw.encode())
            continue

        if row.get("type") == "event_msg" and kind == "token_count":
            info = payload.get("info")
            if info is None:
                if active_turn:
                    source_digest.update(raw.encode())
                continue
            if not isinstance(info, dict):
                raise ValueError("invalid token info")
            cumulative = parse_usage(info.get("total_token_usage"))
            if not active_turn:
                previous_cumulative = cumulative
                previous_cumulative_raw = raw
                continue
            last = parse_usage(info.get("last_token_usage"))
            source_digest.update(raw.encode())
            # The cumulative counter is authoritative. A repeated snapshot
            # contributes zero; a gap that last_token_usage cannot explain
            # is unknown rather than a guessed sum.
            baseline = previous_cumulative or {key: 0 for key in TOKEN_KEYS}
            delta = {}
            for key in TOKEN_KEYS:
                before, after = baseline[key], cumulative[key]
                if before is None or after is None:
                    delta[key] = None
                else:
                    delta[key] = after - before
                    if delta[key] < 0:
                        raise ValueError("cumulative token usage decreased")
            changed = any(delta[key] != 0 for key in REQUIRED_TOKEN_KEYS)
            if changed:
                for key in REQUIRED_TOKEN_KEYS:
                    if delta[key] != last[key]:
                        raise ValueError("cumulative token delta disagrees with last usage")
                if delta["cache_write_input_tokens"] is not None and last["cache_write_input_tokens"] is not None and delta["cache_write_input_tokens"] != last["cache_write_input_tokens"]:
                    raise ValueError("cache-write delta disagrees with last usage")
                for key in TOKEN_KEYS:
                    if totals[key] is not None:
                        totals[key] = totals[key] + delta[key] if delta[key] is not None and last[key] is not None else None
                samples[active_turn] += 1
            elif any(delta[key] not in (0, None) for key in OPTIONAL_TOKEN_KEYS):
                raise ValueError("cache-write usage changed without a token event")
            previous_cumulative = cumulative
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
                content = payload.get("content") or []
                text = "\n".join(item.get("text", "") for item in content if isinstance(item, dict) and isinstance(item.get("text"), str))
                attempts = ATTEMPT_MARKER.findall(text)
                if any(value.lower() != attempt_id.lower() for value in attempts):
                    raise ValueError("another execution attempt appears in selected turn")
                if active_turn == turn_ids[0]:
                    if attempts:
                        if not re.search(rf"(?m)^Task: {re.escape(task_id)}$", text):
                            raise ValueError("attempt marker has a different task")
                        markers[active_turn] += 1
                elif re.search(rf"(?<![A-Z0-9-]){re.escape(card_id)}(?![A-Z0-9-])", text):
                    markers[active_turn] += 1
        elif row.get("type") == "event_msg" and kind == "task_complete":
            if payload.get("turn_id") != active_turn:
                raise ValueError("another turn completed inside selected turn")
            ended_at = timestamp
            if parse_timestamp(ended_at) >= closed_time:
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
        "schemaVersion": 2,
        "source": "codex_cli_cumulative_token_delta",
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
        "baselineUsageSha256": baseline_digest,
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
