import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { amuxSessionClaimMarkerIdentity, localAmuxSessionClaimMarker } from
  "../lib/amux/ideaLocalSessionClaimMarker.mjs";
import { AMUX_SESSION_RETRY_BASE_MS, AMUX_SESSION_RETRY_MAX_MS,
  amuxSessionNextClaimDue, amuxSessionRetryDelayMs } from
  "../lib/amux/ideaSessionAnalysisRetryCore.ts";

const identity = Object.freeze({ claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40", invocationOrdinal: 3 });

test("a marker names only the claim's five identity fields", () => {
  assert.deepEqual(amuxSessionClaimMarkerIdentity({ ...identity,
    provider: "anthropic", prompt: "secret" }), identity);
  for (const bad of [null, [], { ...identity, claimId: "x" },
    { ...identity, invocationOrdinal: -1 }, { ...identity, invocationOrdinal: "3" }]) {
    assert.equal(amuxSessionClaimMarkerIdentity(bad), null, JSON.stringify(bad));
  }
});

test("Linux marker records the claim, is read back by a new instance and removed",
  { skip: process.platform !== "linux" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "amux-v19-marker-"));
    await chmod(directory, 0o700);
    try {
      const first = localAmuxSessionClaimMarker(directory);
      assert.equal(await first.read(), null);
      assert.equal(await first.claim(identity), true);
      assert.equal(await localAmuxSessionClaimMarker(directory).claim(identity), false);
      const pending = await localAmuxSessionClaimMarker(directory).read();
      assert.deepEqual(pending.identity, identity);
      // When it was written, for the absent-claim window of the cycle.
      assert.ok(Math.abs(pending.writtenAtMs - Date.now()) < 60_000);
      const file = join(directory, "analysis-outcome-unknown.halt");
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")),
        { version: 2, identity });
      await first.release();
      assert.equal(await first.read(), null);
      await assert.rejects(first.release(), /local_state_unavailable/);
    } finally { await rmdir(directory); }
  });

test("Linux marker from before 2026-11-16 and the legacy marker name no claim and are removed",
  { skip: process.platform !== "linux" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "amux-v19-marker-"));
    await chmod(directory, 0o700);
    try {
      const marker = localAmuxSessionClaimMarker(directory);
      for (const name of ["analysis-outcome-unknown.halt", "outcome-unknown.halt"]) {
        await writeFile(join(directory, name), "analysis_outcome_unverified\n",
          { mode: 0o600 });
        assert.equal((await marker.read()).identity, null, name);
        await marker.release();
        assert.equal(await marker.read(), null, name);
      }
    } finally { await rmdir(directory); }
  });

test("the marker refuses a relative or missing state directory", () => {
  if (process.platform !== "linux") {
    assert.throws(() => localAmuxSessionClaimMarker("/state"), /local_state_unavailable/);
    return;
  }
  assert.throws(() => localAmuxSessionClaimMarker("relative/state"),
    /local_state_unavailable/);
});

const closed = (status, minutesAgo, now, extra = {}) => ({ status,
  budgetMode: "max_shadow", closedAt: new Date(now.getTime() - minutesAgo * 60_000),
  ownerStopped: false, ...extra });

// Operator, 2026-11-16: a failed subscription analysis is queued again on its
// own, after a wait that doubles with each failure in a row.
test("the retry wait doubles from five minutes up to a day", () => {
  assert.equal(amuxSessionRetryDelayMs(0), 0);
  assert.equal(amuxSessionRetryDelayMs(1), AMUX_SESSION_RETRY_BASE_MS);
  assert.equal(amuxSessionRetryDelayMs(2), 2 * AMUX_SESSION_RETRY_BASE_MS);
  assert.equal(amuxSessionRetryDelayMs(4), 8 * AMUX_SESSION_RETRY_BASE_MS);
  assert.equal(amuxSessionRetryDelayMs(10), AMUX_SESSION_RETRY_MAX_MS);
  assert.equal(amuxSessionRetryDelayMs(1_000), AMUX_SESSION_RETRY_MAX_MS);
});

test("the next claim is due after a result, or after a failure once its wait passed", () => {
  const now = new Date("2026-11-16T12:00:00.000Z");
  assert.deepEqual(amuxSessionNextClaimDue([], now), { due: true, afterFailure: false });
  assert.deepEqual(amuxSessionNextClaimDue([closed("succeeded", 0, now)], now),
    { due: true, afterFailure: false });
  for (const status of ["failed", "owner_consumed", "released"]) {
    assert.deepEqual(amuxSessionNextClaimDue([closed(status, 5, now)], now),
      { due: true, afterFailure: true }, status);
    const waiting = amuxSessionNextClaimDue([closed(status, 4, now)], now);
    assert.equal(waiting.due, false, status);
    assert.equal(waiting.retryAt?.toISOString(), "2026-11-16T12:01:00.000Z");
  }
  // Three failures in a row since the last result wait 20 minutes.
  const streak = [closed("failed", 19, now), closed("owner_consumed", 30, now),
    closed("failed", 60, now), closed("succeeded", 90, now), closed("failed", 120, now)];
  assert.equal(amuxSessionNextClaimDue(streak, now).due, false);
  assert.deepEqual(amuxSessionNextClaimDue([closed("failed", 20, now), ...streak.slice(1)], now),
    { due: true, afterFailure: true });
});

test("a subscription claim left open with an unknown outcome is due at once, for the writer to close", () => {
  const now = new Date("2026-11-16T12:00:00.000Z");
  assert.deepEqual(amuxSessionNextClaimDue([{ status: "outcome_unknown",
    budgetMode: "max_shadow", closedAt: null, ownerStopped: false }], now),
  { due: true, afterFailure: true });
  // The owner's stop still holds it.
  assert.deepEqual(amuxSessionNextClaimDue([{ status: "outcome_unknown",
    budgetMode: "max_shadow", closedAt: null, ownerStopped: true }], now),
  { due: false, retryAt: null });
});

test("a running, paid or owner-stopped claim is never queued again on its own", () => {
  const now = new Date("2026-11-16T12:00:00.000Z");
  for (const latest of [
    { status: "in_flight", budgetMode: "max_shadow", closedAt: null, ownerStopped: false },
    { status: "outcome_unknown", budgetMode: "bounded", closedAt: null, ownerStopped: false },
    closed("failed", 600, now, { budgetMode: "bounded" }),
    closed("owner_consumed", 600, now, { ownerStopped: true }),
    closed("failed", 600, now, { closedAt: null }),
  ]) {
    assert.deepEqual(amuxSessionNextClaimDue([latest], now),
      { due: false, retryAt: null }, JSON.stringify(latest));
  }
});
