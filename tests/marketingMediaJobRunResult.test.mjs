import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = "tools/marketing-video/print-run-result.mjs";
const run = (input) => spawnSync(process.execPath, [script], { input, encoding: "utf8" });
const events = (...list) => `${list.map((event) => JSON.stringify(event)).join("\n")}\n`;

test("a successful run prints its answer and one line of account, and exits 0", () => {
  const out = run(
    events(
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: false, result: '{"job":"marketing-media"}', num_turns: 9, usage: { input_tokens: 12 } },
    ),
  );
  assert.equal(out.status, 0);
  const [answer, account] = out.stdout.trim().split("\n");
  assert.equal(answer, '{"job":"marketing-media"}');
  assert.deepEqual(
    { ...JSON.parse(account), durationMs: null },
    {
      event: "marketing_media_job_run",
      subtype: "success",
      isError: false,
      terminalReason: null,
      apiErrorStatus: null,
      turns: 9,
      durationMs: null,
      inputTokens: 12,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    },
  );
});

test("a run that dies with too long a prompt says why and exits 1", () => {
  const out = run(
    events({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Prompt is too long",
      terminal_reason: "prompt_too_long",
      api_error_status: 400,
    }),
  );
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Prompt is too long/);
  const account = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.equal(account.isError, true);
  assert.equal(account.terminalReason, "prompt_too_long");
  assert.equal(account.apiErrorStatus, 400);
});

test("a stream with no result, or with broken lines, is not called a success", () => {
  for (const input of ["", "not json\n", events({ type: "assistant" })]) {
    const out = run(input);
    assert.equal(out.status, 1, JSON.stringify(input));
    assert.equal(JSON.parse(out.stdout.trim()).subtype, "no_result");
  }
});

test("the daily job keeps the stream outside git and through the reader", () => {
  const daily = readFileSync("tools/marketing-video/run-daily.sh", "utf8");
  assert.match(daily, /--output-format stream-json --verbose/);
  assert.match(daily, /job\/run-\$\(date -u \+%Y%m%d\)\.jsonl/);
  assert.match(daily, /node print-run-result\.mjs/);
  assert.match(readFileSync("tools/marketing-video/.gitignore", "utf8"), /^job\/$/m);
});
