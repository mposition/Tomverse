#!/usr/bin/env node
// Reads the Claude CLI's stream-json on stdin and prints what the plain text
// output used to print, the run's final answer, plus one line on how it ended:
// a failure is reported in the stream, not on stderr. Exits 1 when the run did
// not end in success, so the cron log and run-daily.sh's pipefail both show it.
import { createInterface } from "node:readline";

let result = null;
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const event = JSON.parse(line);
    if (event.type === "result") result = event;
  } catch {
    // A line that is not an event stays in the .jsonl file.
  }
}
if (result === null) {
  console.log(JSON.stringify({ event: "marketing_media_job_run", subtype: "no_result" }));
  process.exit(1);
}
if (typeof result.result === "string") console.log(result.result);
// Only fields that hold no job content.
console.log(
  JSON.stringify({
    event: "marketing_media_job_run",
    subtype: result.subtype ?? null,
    isError: result.is_error === true,
    terminalReason: result.terminal_reason ?? null,
    apiErrorStatus: result.api_error_status ?? null,
    turns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? null,
    inputTokens: result.usage?.input_tokens ?? null,
    cacheReadTokens: result.usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: result.usage?.cache_creation_input_tokens ?? null,
  }),
);
process.exit(result.is_error === true || result.subtype !== "success" ? 1 : 0);
