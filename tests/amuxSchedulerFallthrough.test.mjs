import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A refusal or a lost CAS is a known outcome and the scan moves on (main,
// #1595): one refused task cannot hide later runnable work, and the claim-only
// orchestrator keeps running through a routine refusal. An unknown claim
// outcome halts the orchestrator (policy version 20) -- it no longer ends the
// process.
test("unroutable and refused tasks fall through but an unknown claim outcome halts the orchestrator", async () => {
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
    /ClaimResponse::CasLost \| ClaimResponse::Refused \{ \.\. \} => ClaimFollowUp::NextCandidate/,
  );
  assert.match(scheduler, /ClaimFollowUp::NextCandidate => continue,/);
  assert.match(
    scheduler,
    /ClaimFollowUp::EndTick => \{\s*self\.scan_offset = 0;\s*return Flow::Continue;/,
  );
  assert.doesNotMatch(scheduler, /Dormant/);
  assert.match(scheduler, /CallKind::Claim,\s*ids\.request_id,/);
  assert.match(scheduler, /Settled::Halted => return Flow::Halted,/);
  assert.doesNotMatch(scheduler, /anyhow::anyhow!\("AMUX_CLAIM_OUTCOME_UNKNOWN"\)/);
  assert.match(api, /fn claim_response_status_is_bounded/);
  assert.match(api, /pub enum ClaimResponse/);
});
