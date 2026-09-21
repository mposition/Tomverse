import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("unroutable top task cannot hide lower ranked runnable work", async () => {
  const [scheduler, api] = await Promise.all([
    readFile(
      new URL("../apps/tomverse-orchestrator/src/scheduler.rs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../apps/tomverse-orchestrator/src/tomverse_api.rs", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(scheduler, /MAX_ROUTING_PROBES_PER_TICK: usize = 16/);
  assert.match(scheduler, /\.enumerate\(\)\s*\.skip\(start\)\s*\.take\(end - start\)/);
  assert.match(scheduler, /self\.scan_offset = next_routing_offset\(queue_len, index\);/);
  assert.match(scheduler, /fn routing_fallthrough_is_bounded_and_reaches_later_candidates\(/);
  assert.match(scheduler, /verdict = "no_selected_worker"[\s\S]*?continue;/);
  assert.match(scheduler, /if outcome\.claimed \{\s*self\.scan_offset = 0;\s*return Ok\(\(\)\);/);
  assert.match(api, /status != reqwest::StatusCode::CONFLICT/);
  assert.match(api, /pub reason: Option<String>/);
});
