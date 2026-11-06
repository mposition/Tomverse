import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // No MCP tool may ride in the prompt (2026-11-04 "Prompt is too long").
  assert.match(daily, /ENABLE_CLAUDEAI_MCP_SERVERS=false "\$\{CLAUDE_BIN/);
  assert.match(daily, /--strict-mcp-config/);
  assert.match(daily, /--disallowedTools "mcp__\*"/);
  assert.match(readFileSync("tools/marketing-video/.gitignore", "utf8"), /^job\/$/m);
});

test("a pull that replaces the running script hands over to the new copy from the top", (t) => {
  if (spawnSync("bash", ["-c", "true"]).status !== 0) return t.skip("no bash here");
  const pull = "git -C ../.. pull --ff-only --quiet\n";
  const daily = readFileSync("tools/marketing-video/run-daily.sh", "utf8").replace(/\r\n/g, "\n");
  const cut = daily.indexOf(pull) + pull.length;
  const guard = daily.slice(cut, daily.indexOf("\n", cut) + 1);
  assert.match(guard, /exec bash "\$PWD\/run-daily\.sh"/);
  // The pull is replaced by a copy of the same length, so offsets stay as they would on the box.
  const stand = 'cp "$NEXT_COPY" "$0"'.padEnd(pull.length - 1, " ") + "\n";
  const prefix = daily.slice(0, daily.indexOf(pull)) + stand;
  const dir = mkdtempSync(join(tmpdir(), "media-job-"));
  try {
    const next = join(dir, "next.sh");
    writeFileSync(next, `${prefix}${guard}echo NEW-COPY-RAN\n`);
    writeFileSync(join(dir, "run-daily.sh"), `${prefix}echo OLD-COPY-RAN\n`);
    const out = spawnSync("bash", [join(dir, "run-daily.sh")], {
      encoding: "utf8",
      env: { ...process.env, MARKETING_APP_URL: "http://x", MARKETING_MEDIA_SUBMIT_SECRET: "x", NEXT_COPY: next },
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "NEW-COPY-RAN\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
