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

    def test_turn_after_card_closure_refused(self):
        with self.assertRaises(ValueError):
            module.extract_usage(
                sample_lines(), ATTEMPT, TASK, TURNS, "codex-impl", "CI-6", "2026-10-04T02:44:10Z"
            )


if __name__ == "__main__":
    unittest.main()
