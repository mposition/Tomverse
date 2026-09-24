import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("unroutable tasks fall through but uncertain claim outcomes become dormant", async () => {
  const [scheduler, api] = await Promise.all([
    readFile(
      new URL(
        "../apps/tomverse-orchestrator/src/scheduler.rs",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../apps/tomverse-orchestrator/src/tomverse_api.rs",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(scheduler, /MAX_ROUTING_PROBES_PER_TICK: usize = 16/);
  assert.match(
    scheduler,
    /\.enumerate\(\)\s*\.skip\(start\)\s*\.take\(end - start\)/,
  );
  assert.match(
    scheduler,
    /self\.scan_offset = next_routing_offset\(queue_len, index\);/,
  );
  assert.match(
    scheduler,
    /fn routing_fallthrough_is_bounded_and_reaches_later_candidates\(/,
  );
  assert.match(scheduler, /verdict = "no_selected_worker"[\s\S]*?continue;/);
  assert.match(
    scheduler,
    /ClaimResponse::CasLost \| ClaimResponse::Refused \{ \.\. \} => SchedulerDisposition::Dormant/,
  );
  assert.match(
    scheduler,
    /return Err\(anyhow::anyhow!\("AMUX_CLAIM_OUTCOME_UNKNOWN"\)\)/,
  );
  assert.match(api, /fn claim_response_status_is_bounded/);
  assert.match(api, /pub enum ClaimResponse/);
});
