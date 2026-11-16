import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_CARD_WAIT_INCIDENT_MS,
  AMUX_CARD_WAIT_STALE_MS,
  amuxCardWaitDetail,
  amuxCardWaitFromState,
  amuxCardWaitIncident,
  amuxCardWaitOrdinary,
  amuxCardWaitVisible,
} from "../lib/amux/cardWaitReasonCore.ts";
import {
  amuxWorkerHealthHold,
  amuxWorkerHealthNotice,
  amuxWorkerUsageState,
} from "../lib/amux/workerHealthCore.ts";
import {
  readAmuxV22WorkerHealth,
  writeAmuxV22WorkerHealth,
} from "../lib/amux/v22WorkerHealthFile.mjs";
import {
  amuxV22KeepaliveHealthSignal,
  reportClaudeKeepaliveHealth,
  writeKeepaliveHealth,
} from "../scripts/amux-v22-claude-login-keepalive.mjs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a stored detail keeps codes and worker names only", () => {
  assert.deepEqual(amuxCardWaitDetail({ reasons: ["dependency_unpublished", "Free text!", "dependency_unpublished"],
    routes: [{ worker: "cursor-impl", provider: "cursor", why: "quarantined" },
      { worker: "x y", provider: "cursor", why: "busy" }],
    holdsAll: true, attemptsUsed: 4, maxAttempts: 30, prompt: "never" }),
  { reasons: ["dependency_unpublished"], routes: [{ worker: "cursor-impl", provider: "cursor", why: "quarantined" }],
    holdsAll: true, attemptsUsed: 4, maxAttempts: 30 });
  assert.deepEqual(amuxCardWaitDetail("text"), {});
});

test("a stored reason shows only while it still describes the card", () => {
  const now = 1_000_000_000;
  const row = { stage: "claim", lastSeenAtMs: now - 60_000, cardStatus: "todo", assigned: false, nowMs: now };
  assert.equal(amuxCardWaitVisible(row), true);
  assert.equal(amuxCardWaitVisible({ ...row, cardStatus: "doing" }), false);
  assert.equal(amuxCardWaitVisible({ ...row, assigned: true }), false);
  assert.equal(amuxCardWaitVisible({ ...row, lastSeenAtMs: now - AMUX_CARD_WAIT_STALE_MS - 1 }), false);
  assert.equal(amuxCardWaitVisible({ ...row, stage: "promotion" }), false);
  assert.equal(amuxCardWaitVisible({ ...row, stage: "promotion", cardStatus: "backlog" }), true);
});

test("a backlog card the promotion never read still says why", () => {
  const card = { sourceSystem: "admin-idea-v4", cardType: "task", status: "backlog", assigned: false };
  assert.deepEqual(amuxCardWaitFromState({ ...card, scoreFresh: false, openDependencies: 0 }),
    { stage: "promotion", code: "score_stale" });
  assert.deepEqual(amuxCardWaitFromState({ ...card, scoreFresh: true, openDependencies: 2 }),
    { stage: "promotion", code: "dependency_incomplete" });
  assert.equal(amuxCardWaitFromState({ ...card, scoreFresh: true, openDependencies: 0 }), null);
  assert.equal(amuxCardWaitFromState({ ...card, status: "todo", scoreFresh: false, openDependencies: 0 }), null);
});

test("a long claim wait is raised once, naming the cards and their causes", () => {
  const now = 2_000_000_000;
  const old = now - AMUX_CARD_WAIT_INCIDENT_MS;
  const rows = [
    { taskId: "t1", displayKey: "AMUX-FILEGEN2-003", stage: "claim", code: "task_not_ready",
      detail: { reasons: ["dependency_unpublished"] }, firstSeenAtMs: old, reportedAtMs: null },
    { taskId: "t2", displayKey: "AMUX-X-001", stage: "claim", code: "worker_quarantined",
      detail: { routes: [{ worker: "cursor-impl", provider: "cursor", why: "quarantined" }] },
      firstSeenAtMs: old, reportedAtMs: null },
    { taskId: "t3", displayKey: "AMUX-X-002", stage: "claim", code: "global_capacity_full",
      detail: { holdsAll: true }, firstSeenAtMs: old, reportedAtMs: null },
    { taskId: "t4", displayKey: "AMUX-X-003", stage: "claim", code: "task_not_ready",
      detail: { reasons: ["dependency_incomplete"] }, firstSeenAtMs: old, reportedAtMs: null },
    { taskId: "t5", displayKey: "AMUX-X-004", stage: "claim", code: "worker_unavailable",
      detail: {}, firstSeenAtMs: now - 60_000, reportedAtMs: null },
    { taskId: "t6", displayKey: "AMUX-X-005", stage: "claim", code: "worker_unavailable",
      detail: {}, firstSeenAtMs: old, reportedAtMs: old },
    { taskId: "t7", displayKey: "AMUX-X-006", stage: "promotion", code: "task_not_ready",
      detail: {}, firstSeenAtMs: old, reportedAtMs: null },
  ];
  const incident = amuxCardWaitIncident(rows, now);
  assert.deepEqual(incident.taskIds, ["t1", "t2"]);
  assert.equal(incident.tasks,
    "AMUX-FILEGEN2-003: task_not_ready (dependency_unpublished); AMUX-X-001: worker_quarantined (quarantined)");
  assert.equal(amuxCardWaitOrdinary("global_capacity_full", {}), true);
  assert.equal(amuxCardWaitOrdinary("task_not_ready", { reasons: ["dependency_incomplete"] }), true);
  assert.equal(amuxCardWaitOrdinary("task_not_ready", { reasons: ["dependency_unpublished"] }), false);
  assert.equal(amuxCardWaitIncident(rows.slice(2), now), null);
});

const view = (over = {}) => ({ workerName: "claude-impl",
  circuit: { state: "closed", consecutive: 0, lastKind: null, lastAt: null, retryAt: null },
  usage: { state: "fresh", observedAt: "2026-11-15T07:00:00.000Z", exhausted: false },
  signals: [], ...over });

test("can take work means the claim would assign it work", () => {
  const anthropic = { provider: "claude" };
  assert.equal(amuxWorkerHealthHold(view(), anthropic), null);
  // 2026-11-15: the Claude login expired and the bridge could no longer read usage.
  assert.equal(amuxWorkerHealthHold(view({ usage: { state: "stale", observedAt: null, exhausted: false } }), anthropic),
    "usage_unobserved");
  assert.equal(amuxWorkerHealthHold(view({ usage: { state: "missing", observedAt: null, exhausted: false } }),
    { provider: "cursor" }), null, "another provider is not gated on a missing reading");
  assert.equal(amuxWorkerHealthHold(view({ usage: { state: "fresh", observedAt: null, exhausted: true } }),
    { provider: "cursor" }), "usage_exhausted");
  assert.equal(amuxWorkerHealthHold(view({ circuit: { state: "open", consecutive: 3, lastKind: "early_exit",
    lastAt: null, retryAt: null } }), anthropic), "infra_quarantined");
  // A box sign-in signal warns; it never claims a hold the claim does not apply.
  const staged = view({ signals: [{ source: "auth_stage", signal: "auth_stage_failed",
    observedAt: "x", firstSeenAt: "x", expiresAt: null }] });
  assert.equal(amuxWorkerHealthHold(staged, anthropic), null);
  assert.equal(amuxWorkerHealthNotice(staged), "login_attention");
  assert.equal(amuxWorkerHealthNotice(view({ signals: [{ source: "login_keepalive", signal: "relogin_soon",
    observedAt: "x", firstSeenAt: "x", expiresAt: "2026-11-16T04:05:50.000Z" }] })), "relogin_soon");
  assert.equal(amuxWorkerHealthNotice(view({ circuit: { state: "probing", consecutive: 3, lastKind: "early_exit",
    lastAt: null, retryAt: null } })), "probing");
  assert.equal(amuxWorkerUsageState(null, 0), "missing");
  assert.equal(amuxWorkerUsageState(0, 60 * 60_000), "fresh");
  assert.equal(amuxWorkerUsageState(0, 60 * 60_000 + 1), "stale");
});

test("the box writes a health signal next to the copy and the sidecar reads it back, codes only", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-health-"));
  try {
    await mkdir(join(root, "tomverse-amux-v22-claude-impl", "cli"), { recursive: true });
    await writeAmuxV22WorkerHealth({ worker: "claude-impl", stateRoot: root, source: "login_keepalive",
      signal: "relogin_soon", observedAt: "2026-11-15T07:00:00Z", expiresAt: "2026-11-16T04:05:50Z" });
    await writeAmuxV22WorkerHealth({ worker: "claude-impl", stateRoot: root, source: "auth_stage",
      signal: "auth_stage_failed", observedAt: "2026-11-15T07:05:00Z" });
    const directory = join(root, "tomverse-amux-v22-claude-impl", "cli");
    const raw = JSON.parse(await readFile(join(directory, "amux-health-login_keepalive.json"), "utf8"));
    assert.deepEqual(Object.keys(raw).sort(), ["expiresAt", "observedAt", "signal", "source", "version"]);
    assert.deepEqual(await readAmuxV22WorkerHealth(directory), [
      { source: "login_keepalive", signal: "relogin_soon", observedAt: "2026-11-15T07:00:00.000Z",
        expiresAt: "2026-11-16T04:05:50.000Z" },
      { source: "auth_stage", signal: "auth_stage_failed", observedAt: "2026-11-15T07:05:00.000Z" },
    ]);
    await assert.rejects(writeAmuxV22WorkerHealth({ worker: "claude-impl", stateRoot: root,
      source: "auth_stage", signal: "Token: abc", observedAt: "2026-11-15T07:05:00Z" }));
    assert.deepEqual(await readAmuxV22WorkerHealth(join(root, "missing")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the installed keepalive writes the shape the sidecar reads, for every Claude worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-keepalive-health-"));
  try {
    for (const worker of ["claude-impl", "claude-chore"])
      await mkdir(join(root, `tomverse-amux-v22-${worker}`, "cli"), { recursive: true });
    await reportClaudeKeepaliveHealth(["claude-impl", "claude-chore"],
      { outcome: "login_required", state: "login_required", refreshTokenExpiresAt: "2026-11-15T04:05:50.000Z" },
      (input) => writeKeepaliveHealth({ ...input, stateRoot: root }));
    for (const worker of ["claude-impl", "claude-chore"]) {
      const [signal] = await readAmuxV22WorkerHealth(join(root, `tomverse-amux-v22-${worker}`, "cli"));
      assert.equal(signal.source, "login_keepalive");
      assert.equal(signal.signal, "login_required");
      assert.equal(signal.expiresAt, "2026-11-15T04:05:50.000Z");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("each keepalive outcome is one health signal", () => {
  assert.equal(amuxV22KeepaliveHealthSignal({ outcome: "fresh" }), "ok");
  assert.equal(amuxV22KeepaliveHealthSignal({ outcome: "refreshed", warning: "relogin_soon" }), "relogin_soon");
  assert.equal(amuxV22KeepaliveHealthSignal({ outcome: "refresh_failed" }), "refresh_failed");
  assert.equal(amuxV22KeepaliveHealthSignal({ outcome: "login_required", state: "missing" }), "login_missing");
  assert.equal(amuxV22KeepaliveHealthSignal({ outcome: "login_required", state: "login_required" }), "login_required");
});
