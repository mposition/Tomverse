import importlib.util
import json
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "amux_codex_usage_receipt.py"
spec = importlib.util.spec_from_file_location("amux_codex_usage_receipt", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ATTEMPT = "6ec36df7-4785-4efb-b0e2-ba70ea881413"
TASK = "cmuers9qy00nf02nzk2ldl3j9"
TURNS = ["turn-1", "turn-2"]


def event(kind, payload, at):
    timestamp = f"2026-10-04T02:44:{int(at[1:]):02d}Z"
    return json.dumps({"timestamp": timestamp, "type": kind, "payload": payload}) + "\n"


def token_event(input_tokens, output_tokens, at, total=None):
    return event(
        "event_msg",
        {
            "type": "token_count",
            "info": {
                "last_token_usage": {
                    "input_tokens": input_tokens,
                    "cached_input_tokens": input_tokens // 2,
                    "cache_write_input_tokens": 0,
                    "output_tokens": output_tokens,
                    "reasoning_output_tokens": 1,
                    "total_tokens": total if total is not None else input_tokens + output_tokens,
                }
            },
        },
        at,
    )


def user_event(turn, text, at):
    return event(
        "response_item",
        {
            "type": "message",
            "role": "user",
            "content": [{"text": text}],
            "internal_chat_message_metadata_passthrough": {"turn_id": turn},
        },
        at,
    )


def sample_lines(*, marker=True, duplicate=False, total=13, interloper=False):
    lines = [
        event("session_meta", {"id": "session-1", "cli_version": "0.155.0", "model_provider": "openai"}, "t00"),
        event("event_msg", {"type": "task_started", "turn_id": TURNS[0]}, "t01"),
        event("turn_context", {"turn_id": TURNS[0], "model": "gpt-5.6-sol"}, "t02"),
        user_event(TURNS[0], f"Task: {TASK}\nExecution attempt: {ATTEMPT}" if marker else "other task", "t03"),
        token_event(10, 3, "t04", total),
        event("event_msg", {"type": "task_complete", "turn_id": TURNS[0]}, "t05"),
    ]
    if interloper:
        lines.append(event("event_msg", {"type": "task_started", "turn_id": "other"}, "t06"))
    lines += [
        event("event_msg", {"type": "task_started", "turn_id": TURNS[1]}, "t07"),
        event("turn_context", {"turn_id": TURNS[1], "model": "gpt-5.6-sol"}, "t08"),
        user_event(TURNS[1], "Please continue CI-6", "t09"),
        token_event(20, 4, "t10"),
        event("event_msg", {"type": "task_complete", "turn_id": TURNS[1]}, "t11"),
        event("event_msg", {"type": "task_started", "turn_id": "later"}, "t13"),
        token_event(900, 10, "t14"),
    ]
    if duplicate:
        lines.insert(4, lines[3])
    cumulative = {key: 0 for key in module.TOKEN_KEYS}
    for index, raw in enumerate(lines):
        row = json.loads(raw)
        payload = row.get("payload") or {}
        if row.get("type") == "event_msg" and payload.get("type") == "token_count":
            info = payload["info"]
            last = info["last_token_usage"]
            for key in module.TOKEN_KEYS:
                cumulative[key] += last[key]
            info["total_token_usage"] = {
                **cumulative,
                "total_tokens": cumulative["input_tokens"] + cumulative["output_tokens"],
            }
            lines[index] = json.dumps(row) + "\n"
    return lines


class UsageReceiptTest(unittest.TestCase):
    def extract(self, lines):
        return module.extract_usage(lines, ATTEMPT, TASK, TURNS, "codex-impl", "CI-6", "2026-10-04T02:44:12Z")

    def test_binds_both_turns_and_excludes_after_closure(self):
        receipt = self.extract(sample_lines())
        self.assertEqual(receipt["usage"]["inputTokens"], 30)
        self.assertEqual(receipt["usage"]["outputTokens"], 7)
        self.assertEqual(receipt["usageSamples"], 2)
        self.assertEqual(receipt["endedAt"], "2026-10-04T02:44:11Z")
        self.assertEqual(receipt["turnIds"], TURNS)
        self.assertEqual(len(receipt["sourceSpanSha256"]), 64)
        self.assertIsNone(receipt["actualBilledCostMicrousd"])

    def test_missing_or_duplicate_attempt_marker_refused(self):
        with self.assertRaises(ValueError):
            self.extract(sample_lines(marker=False))
        with self.assertRaises(ValueError):
            self.extract(sample_lines(duplicate=True))

    def test_unselected_turn_or_bad_usage_refused(self):
        with self.assertRaises(ValueError):
            self.extract(sample_lines(interloper=True))
        with self.assertRaises(ValueError):
            self.extract(sample_lines(total=12))

    def test_repeated_token_snapshot_and_null_info_do_not_overcount(self):
        lines = sample_lines()
        repeated = json.loads(lines[4])
        repeated["timestamp"] = "2026-10-04T02:44:04.500Z"
        lines.insert(5, json.dumps(repeated) + "\n")
        null = json.loads(lines[5])
        null["payload"]["info"] = None
        lines.insert(6, json.dumps(null) + "\n")
        receipt = self.extract(lines)
        self.assertEqual(receipt["usage"]["inputTokens"], 30)
        self.assertEqual(receipt["usageSamples"], 2)

    def test_prior_session_usage_is_baseline_not_this_attempt(self):
        lines = sample_lines()
        prior = json.loads(token_event(100, 2, "t00"))
        prior["payload"]["info"]["total_token_usage"] = dict(prior["payload"]["info"]["last_token_usage"])
        lines.insert(1, json.dumps(prior) + "\n")
        for index, raw in enumerate(lines[2:], start=2):
            row = json.loads(raw)
            info = (row.get("payload") or {}).get("info")
            if isinstance(info, dict):
                total = info["total_token_usage"]
                for key in module.TOKEN_KEYS:
                    total[key] += prior["payload"]["info"]["last_token_usage"][key]
                total["total_tokens"] = total["input_tokens"] + total["output_tokens"]
                lines[index] = json.dumps(row) + "\n"
        receipt = self.extract(lines)
        self.assertEqual(receipt["usage"]["inputTokens"], 30)
        self.assertEqual(receipt["usage"]["outputTokens"], 7)
        self.assertEqual(len(receipt["baselineUsageSha256"]), 64)

    def test_missing_cache_write_is_unknown_not_zero(self):
        lines = sample_lines()
        for index, raw in enumerate(lines):
            row = json.loads(raw)
            info = (row.get("payload") or {}).get("info")
            if isinstance(info, dict):
                info["last_token_usage"].pop("cache_write_input_tokens")
                info["total_token_usage"].pop("cache_write_input_tokens")
                lines[index] = json.dumps(row) + "\n"
        self.assertIsNone(self.extract(lines)["usage"]["cacheWriteInputTokens"])

    def test_task_id_prefix_and_naive_closure_are_refused(self):
        lines = sample_lines()
        lines[3] = user_event(TURNS[0], f"Task: {TASK}suffix\nExecution attempt: {ATTEMPT}", "t03")
        with self.assertRaisesRegex(ValueError, "different task"):
            self.extract(lines)
        with self.assertRaisesRegex(ValueError, "timezone"):
            module.extract_usage(sample_lines(), ATTEMPT, TASK, TURNS, "codex-impl", "CI-6", "2026-10-04T02:44:12")

    def test_uppercase_attempt_markers_are_compared_case_insensitively(self):
        lines = sample_lines()
        lines[3] = user_event(
            TURNS[0], f"Task: {TASK}\nExecution attempt: {ATTEMPT.upper()}", "t03"
        )
        self.assertEqual(self.extract(lines)["attemptId"], ATTEMPT)
        foreign = "abcdef00-0000-4000-8000-000000000001"
        lines[3] = user_event(
            TURNS[0],
            f"Task: {TASK}\nExecution attempt: {ATTEMPT}\nExecution attempt: {foreign.upper()}",
            "t03",
        )
        with self.assertRaisesRegex(ValueError, "another execution attempt"):
            self.extract(lines)

    def test_naive_rollout_timestamp_is_refused_with_value_error(self):
        lines = sample_lines()
        started = json.loads(lines[1])
        started["timestamp"] = started["timestamp"].removesuffix("Z")
        lines[1] = json.dumps(started) + "\n"
        with self.assertRaisesRegex(ValueError, "timezone"):
            self.extract(lines)

    def test_non_text_rollout_timestamp_is_refused_with_value_error(self):
        lines = sample_lines()
        started = json.loads(lines[1])
        for non_text_timestamp in (None, 1791081852):
            started["timestamp"] = non_text_timestamp
            lines[1] = json.dumps(started) + "\n"
            with self.assertRaisesRegex(ValueError, "ISO string"):
                self.extract(lines)

    def test_cumulative_gap_is_refused(self):
        lines = sample_lines()
        row = json.loads(lines[4])
        row["payload"]["info"]["total_token_usage"]["input_tokens"] += 1
        row["payload"]["info"]["total_token_usage"]["total_tokens"] += 1
        lines[4] = json.dumps(row) + "\n"
        with self.assertRaisesRegex(ValueError, "delta disagrees"):
            self.extract(lines)

    def test_turn_after_card_closure_refused(self):
        with self.assertRaises(ValueError):
            module.extract_usage(
                sample_lines(), ATTEMPT, TASK, TURNS, "codex-impl", "CI-6", "2026-10-04T02:44:10Z"
            )


if __name__ == "__main__":
    unittest.main()
