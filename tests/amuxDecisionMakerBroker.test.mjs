// The AMUX Decision Maker broker, stage S2-3b (docs/policy/amux-decision-maker.md
// policy version 2, §2-4, §2-5, §5, §10), driven by a fake bridge over local
// sockets, with the real launcher side on a re-rooted host and a stand-in CLI,
// or a scripted launcher. No real CLI runs and nothing is sent anywhere.
//
// §12's blocking criteria this file holds at the broker: no DM process starts
// without the recorded transmission intent for the exact bytes; the request
// directory is deleted on every exit path, and anything the broker cannot
// verify is cleanup_unknown; the broker checks for a leftover request
// directory before the next request; the DM output goes to the bridge and
// nowhere else.
//
// Refusals, lost launchers and the protocol run everywhere. Starting a
// process (the stand-in CLI) and owners and modes need POSIX.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  DM_WORKSPACE_GIT_FLAGS,
  buildDmWorkspace,
  dmWorkspaceHttpClient,
  dmWorkspaceSystemGitEnvironment,
} from "../lib/amux/decisionMakerWorkspaceBuild.ts";
import {
  DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES,
  dmEncodeLaunchWorkspace,
  dmEncodeLaunchWorkspaceParts,
  dmWorkspacePayloadLines,
  gitBlobId,
} from "../lib/amux/decisionMakerWorkspaceCore.ts";
import { dmEncodePartLine } from "../lib/amux/decisionMakerBrokerCore.ts";
import { createHash } from "node:crypto";
import { DM_SYSTEM_HOST } from "../lib/amux/decisionMakerLauncherFs.ts";

const makeTempRoot = () => mkdtempSync(join(tmpdir(), "amux-dm-workspace-"));

import { createDecisionMakerBroker, dmSystemdListenFd } from "../lib/amux/decisionMakerBroker.ts";
import { dmEncodeLauncherLaunched, dmEncodeLauncherReady } from "../lib/amux/decisionMakerBrokerCore.ts";
import { dmPayloadDigest, dmResultDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import { DM_REQUEST_ROOT, dmRequestPaths } from "../lib/amux/decisionMakerLauncherCore.ts";
import {
  DM_REQUEST_DIRECTORY_MODE,
  dmCreateRequestDirectory,
  dmRequestRootState,
  dmVendorGroupId,
} from "../lib/amux/decisionMakerLauncherFs.ts";
import { serveDecisionMakerLauncherConnection } from "../lib/amux/decisionMakerLauncherService.ts";
import { dmReadLine, dmWriteLine } from "../lib/amux/decisionMakerSocketLine.ts";
import { launchLine, startBroker } from "./support/amuxDmBrokerFixture.mjs";
import { PAYLOAD, REQUEST_ID, REQUEST_KEY, fakeCli, makeLauncherFixture } from "./support/amuxDmLauncherFixture.mjs";

const OPENAI = "decision-maker-openai";
const ANTHROPIC = "decision-maker-anthropic";
const posix = process.platform !== "win32";
const VERIFIED = { status: "verified" };
const OTHER_REQUEST = "0a1b2c3d-4e5f-4a6b-8c7d-000000000002";

const select = { kind: "select", optionId: "b", rationale: "Smaller change.", irreversible: false };

const withBroker = async (instance, options, body) => {
  const broker = await startBroker(instance, options);
  try {
    return await body(broker);
  } finally {
    await broker.stop();
  }
};

/** A scripted launcher: sends `ready` for `instance`, reads the request, then does `then`. */
const scripted = (instance, then) => async (socket, fixture) => {
  await dmWriteLine(socket, dmEncodeLauncherReady(instance), 2_000);
  const read = await dmReadLine(socket, 1024 * 1024, 5_000);
  await then(socket, read.ok ? JSON.parse(read.line) : null, fixture);
};

// ---------------------------------------------------------------------------
// §10: nothing is made and no launcher is asked without the recorded intent
// ---------------------------------------------------------------------------

test("§10: without the recorded intent for these bytes no directory is made and no launcher is asked", async () => {
  await withBroker(OPENAI, {}, async (broker) => {
    const cases = [
      [{ transmitIntent: null }, "transmit_intent_missing"],
      [{ transmitIntent: { ...broker.fixture.evidence, recorded: false } }, "transmit_intent_missing"],
      [{ payload: Buffer.concat([PAYLOAD, Buffer.from("+")]).toString("base64") }, "transmit_intent_mismatch"],
      [{ transmitIntent: { ...broker.fixture.evidence, requestId: OTHER_REQUEST } }, "transmit_intent_mismatch"],
      [{ transmitIntent: { ...broker.fixture.evidence, instance: ANTHROPIC } }, "transmit_intent_mismatch"],
    ];
    for (const [overrides, refusal] of cases) {
      const answer = await broker.call(launchLine(broker.fixture, overrides));
      assert.equal(answer.transmission, "not_started", refusal);
      assert.deepEqual(answer.launch, { outcome: "broker_refused", reasons: [refusal] });
      assert.deepEqual(answer.result, { kind: "unavailable" });
      assert.equal(answer.resultDigest, dmResultDigest(REQUEST_KEY, { kind: "unavailable" }));
      assert.deepEqual(answer.cleanup, VERIFIED);
    }
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
  });
});

test("a line that is not exactly a launch request is answered with a refusal and touches nothing", async () => {
  await withBroker(OPENAI, { timeouts: { requestRead: 200 } }, async (broker) => {
    const expectations = [
      ["not json\n", "request_malformed", null],
      [`${JSON.stringify({ ...launchLine(broker.fixture), extra: 1 })}\n`, "request_malformed", null],
      [`${JSON.stringify(launchLine(broker.fixture))}\nmore`, "request_unreadable", null],
      [`${JSON.stringify(launchLine(broker.fixture, { instance: "decision-maker-gemini" }))}\n`, "instance_unknown", REQUEST_ID],
      [`${JSON.stringify(launchLine(broker.fixture, { payload: "" }))}\n`, "payload_invalid", REQUEST_ID],
      // The bridge connects and says nothing.
      ["", "request_unreadable", null],
    ];
    for (const [text, refusal, requestId] of expectations) {
      const answer = await broker.call(text);
      assert.deepEqual(answer.launch, { outcome: "broker_refused", reasons: [refusal] }, text.slice(0, 60));
      assert.equal(answer.requestId, requestId);
      assert.equal(answer.transmission, "not_started");
    }
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
  });
});

// ---------------------------------------------------------------------------
// §5: the request root and the request directory
// ---------------------------------------------------------------------------

test("§5: a leftover in the request root refuses the request, is left alone, and is cleanup_unknown", async () => {
  await withBroker(OPENAI, {}, async (broker) => {
    const leftover = broker.fixture.at(`${DM_REQUEST_ROOT}/${OTHER_REQUEST}`);
    mkdirSync(leftover, { mode: 0o750 });
    const answer = await broker.call(launchLine(broker.fixture));
    assert.deepEqual(answer.launch, { outcome: "broker_refused", reasons: ["request_root_leftover"] });
    assert.equal(answer.transmission, "not_started");
    assert.deepEqual(answer.cleanup, {
      status: "cleanup_unknown",
      residue: [{ scope: "request_root", kind: "request_root_leftover" }],
    });
    assert.equal(existsSync(leftover), true, "the broker does not delete what it did not make for this request");
    assert.equal(broker.launcherConnections.length, 0);
  });
});

test("§5: a request root that is missing is refused as unusable and cleanup_unknown", async () => {
  await withBroker(OPENAI, {}, async (broker) => {
    rmSync(broker.fixture.at(DM_REQUEST_ROOT), { recursive: true });
    const answer = await broker.call(launchLine(broker.fixture));
    assert.deepEqual(answer.launch, { outcome: "broker_refused", reasons: ["request_root_unusable"] });
    assert.equal(answer.cleanup.status, "cleanup_unknown");
  });
});

test("§5: the launcher finds the request directory made, empty, and the broker deletes it after the answer", async () => {
  const seen = [];
  const launcher = scripted(OPENAI, async (socket, request, fixture) => {
    const path = fixture.at(fixture.paths.requestDirectory);
    const stats = statSync(path);
    seen.push({ entries: readdirSync(path), mode: stats.mode & 0o7777, gid: stats.gid, request });
    await dmWriteLine(socket, dmEncodeLauncherLaunched(request, { outcome: "timeout" }, VERIFIED), 2_000);
    socket.end();
  });
  await withBroker(OPENAI, { launcher }, async (broker) => {
    const answer = await broker.call(launchLine(broker.fixture));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].entries, [], "the card goes on stdin (§5a); S2b's snapshot is not part of this stage");
    if (posix) {
      assert.equal(seen[0].mode, DM_REQUEST_DIRECTORY_MODE);
      assert.equal(seen[0].gid, statSync(broker.fixture.at(broker.fixture.spec.home)).gid, "the vendor account's group");
    }
    // The launcher receives exactly what the bridge sent.
    assert.deepEqual(seen[0].request, launchLine(broker.fixture));
    assert.equal(answer.transmission, "process_ended");
    assert.deepEqual(answer.result, { kind: "timeout" });
    assert.deepEqual(answer.cleanup, VERIFIED);
    assert.equal(existsSync(broker.requestDirectory()), false);
    assert.deepEqual(readdirSync(broker.fixture.at(DM_REQUEST_ROOT)), []);
  });
});

test("§5: the vendor group must be one the broker is in, read from the home S0 made", () => {
  const fixture = makeLauncherFixture(OPENAI, { requestDirectory: false });
  try {
    const group = dmVendorGroupId(fixture.host, OPENAI);
    assert.equal(group.ok, true);
    if (posix) assert.equal(group.groupId, statSync(fixture.at(fixture.spec.home)).gid);
    else assert.equal(group.groupId, null, "no POSIX groups: none is set");
    rmSync(fixture.at(fixture.spec.home), { recursive: true });
    if (posix) assert.deepEqual(dmVendorGroupId(fixture.host, OPENAI), { ok: false });
    // An id that is not the app's names no directory; an existing name is never reused.
    assert.equal(dmCreateRequestDirectory(fixture.host, OPENAI, "../x", null), false);
    mkdirSync(fixture.at(fixture.paths.requestDirectory));
    assert.equal(dmCreateRequestDirectory(fixture.host, OPENAI, REQUEST_ID, group.groupId), false);
    assert.deepEqual(dmRequestRootState(fixture.host, new Set([REQUEST_ID])), { state: "ok", leftover: 0 });
    assert.deepEqual(dmRequestRootState(fixture.host, new Set()), { state: "ok", leftover: 1 });
  } finally {
    fixture.dispose();
  }
});

// ---------------------------------------------------------------------------
// One request per instance at a time
// ---------------------------------------------------------------------------

test("a second request for an instance in flight is refused busy without touching the first one's directory", async () => {
  let release;
  const released = new Promise((done) => {
    release = done;
  });
  let entered;
  const inside = new Promise((done) => {
    entered = done;
  });
  const launcher = scripted(OPENAI, async (socket, request) => {
    entered();
    await released;
    await dmWriteLine(socket, dmEncodeLauncherLaunched(request, { outcome: "timeout" }, VERIFIED), 2_000);
    socket.end();
  });
  await withBroker(OPENAI, { launcher }, async (broker) => {
    const first = broker.call(launchLine(broker.fixture));
    await inside;
    assert.deepEqual([...broker.broker.inFlight()], [[OPENAI, REQUEST_ID]]);
    for (const overrides of [{}, { requestId: OTHER_REQUEST }]) {
      const second = await broker.call(launchLine(broker.fixture, overrides));
      assert.deepEqual(second.launch, { outcome: "broker_refused", reasons: ["busy"] });
      assert.equal(second.transmission, "not_started");
      assert.deepEqual(second.cleanup, VERIFIED);
      assert.equal(existsSync(broker.requestDirectory()), true, "the request in flight keeps its directory");
    }
    release();
    const answer = await first;
    assert.deepEqual(answer.result, { kind: "timeout" });
    assert.equal(existsSync(broker.requestDirectory()), false);
    assert.equal(broker.broker.inFlight().size, 0);
  });
});

// ---------------------------------------------------------------------------
// The launcher: unreachable, lost, rejected, answered
// ---------------------------------------------------------------------------

test("a launcher that cannot be reached, or does not say ready for this instance, was sent nothing", async () => {
  await withBroker(OPENAI, { launcher: "absent" }, async (broker) => {
    const answer = await broker.call(launchLine(broker.fixture));
    assert.deepEqual(answer.launch, { outcome: "launcher_unreachable", reasons: ["connect_failed"] });
    assert.equal(answer.transmission, "not_started");
    assert.deepEqual(answer.cleanup, VERIFIED, "the broker's own directory was made and deleted");
    assert.equal(existsSync(broker.requestDirectory()), false);
  });
  const closesAtOnce = (socket) => socket.destroy();
  const wrongInstance = async (socket) => {
    await dmWriteLine(socket, dmEncodeLauncherReady(ANTHROPIC), 2_000);
    socket.end();
  };
  for (const [launcher, reason] of [[closesAtOnce, "ready_missing"], [wrongInstance, "ready_mismatch"]]) {
    await withBroker(OPENAI, { launcher }, async (broker) => {
      const answer = await broker.call(launchLine(broker.fixture));
      assert.deepEqual(answer.launch, { outcome: "launcher_unreachable", reasons: [reason] });
      assert.equal(answer.transmission, "not_started");
      assert.equal(existsSync(broker.requestDirectory()), false);
    });
  }
});

test("a launcher that took the request and gave no valid answer: transmission and cleanup unknown", async () => {
  const cases = [
    [async (socket) => socket.end(), "response_missing", {}],
    [async (socket) => {
      await dmWriteLine(socket, { v: 1, type: "launched", requestId: REQUEST_ID }, 2_000);
      socket.end();
    }, "response_malformed", {}],
    [async (socket, request) => {
      await dmWriteLine(socket, dmEncodeLauncherLaunched({ ...request, requestId: OTHER_REQUEST }, { outcome: "timeout" }, VERIFIED), 2_000);
      socket.end();
    }, "response_malformed", {}],
    [async () => {}, "response_timeout", { timeouts: { launcherResponse: 300 } }],
  ];
  for (const [then, reason, options] of cases) {
    await withBroker(OPENAI, { launcher: scripted(OPENAI, then), ...options }, async (broker) => {
      const answer = await broker.call(launchLine(broker.fixture));
      assert.deepEqual(answer.launch, { outcome: "launcher_lost", reasons: [reason] });
      assert.equal(answer.transmission, "unknown");
      assert.deepEqual(answer.result, { kind: "unavailable" });
      assert.deepEqual(answer.cleanup, {
        status: "cleanup_unknown",
        residue: [{ scope: "vendor", kind: "launcher_report_missing" }],
      });
      assert.equal(existsSync(broker.requestDirectory()), false, "the request directory is deleted whatever happened");
    });
  }
});

test("the launcher's cleanup_unknown reaches the bridge with its kinds", async () => {
  const launcher = scripted(OPENAI, async (socket, request) => {
    const cleanup = { status: "cleanup_unknown", residue: [{ kind: "state_entry_present", path: "/home/amux-dm-openai/.codex/x" }] };
    await dmWriteLine(socket, dmEncodeLauncherLaunched(request, { outcome: "unavailable", reason: "exit_code_1" }, cleanup), 2_000);
    socket.end();
  });
  await withBroker(OPENAI, { launcher }, async (broker) => {
    const answer = await broker.call(launchLine(broker.fixture));
    assert.equal(answer.transmission, "process_ended");
    assert.deepEqual(answer.launch, { outcome: "unavailable", reasons: ["exit_code_1"] });
    assert.deepEqual(answer.cleanup, { status: "cleanup_unknown", residue: [{ scope: "vendor", kind: "state_entry_present" }] });
  });
});

test("§5a through the real launcher side: a refused preflight starts nothing and is DM 불가", async () => {
  await withBroker(OPENAI, {}, async (broker) => {
    // The launcher side now expects another sha256 than the stand-in's, as it would §5a's.
    const original = broker.fixture.executableSha256;
    broker.fixture.executableSha256 = "0".repeat(64);
    try {
      const answer = await broker.call(launchLine(broker.fixture));
      assert.equal(answer.transmission, "not_started");
      assert.deepEqual(answer.launch, { outcome: "refused", reasons: ["executable_sha256_mismatch"] });
      assert.deepEqual(answer.result, { kind: "unavailable" });
      assert.deepEqual(answer.cleanup, VERIFIED);
      assert.equal(existsSync(broker.requestDirectory()), false);
    } finally {
      broker.fixture.executableSha256 = original;
    }
  });
});

test("a launcher answers rejected, and starts nothing, for another instance's request or a malformed one", async () => {
  const fixture = makeLauncherFixture(OPENAI);
  try {
    const run = async (send) => {
      const { PassThrough, Duplex } = await import("node:stream");
      const toLauncher = new PassThrough();
      const fromLauncher = new PassThrough();
      const stream = Duplex.from({ readable: toLauncher, writable: fromLauncher });
      const served = serveDecisionMakerLauncherConnection(stream, { instance: OPENAI, host: fixture.host, requestReadTimeoutMs: 1_000 });
      const ready = await dmReadLine(fromLauncher, 1024, 1_000);
      assert.deepEqual(JSON.parse(ready.line), { v: 1, type: "ready", instance: OPENAI });
      toLauncher.write(send);
      const answer = await dmReadLine(fromLauncher, 1024 * 1024, 5_000);
      return { served: await served, answer: JSON.parse(answer.line) };
    };
    const wrong = await run(`${JSON.stringify(launchLine(fixture, { instance: ANTHROPIC }))}\n`);
    assert.deepEqual(wrong.answer, { v: 1, type: "rejected", error: "instance_mismatch", cleanup: VERIFIED });
    const malformed = await run("{}\n");
    assert.equal(malformed.answer.error, "request_malformed");
    assert.equal(existsSync(fixture.at("/observed/started")), false);
  } finally {
    fixture.dispose();
  }
});

// ---------------------------------------------------------------------------
// The whole path, with a stand-in CLI (POSIX)
// ---------------------------------------------------------------------------

const RECORD = `
fs.writeFileSync(at("/observed/started"), "1");
fs.writeFileSync(at("/observed/cwd"), process.cwd());
fs.writeFileSync(at("/observed/stdin"), fs.readFileSync(0));
`;

test("§2-5: a DM output reaches the bridge, and only the bridge, with its result digest; everything is cleaned", { skip: !posix }, async () => {
  const body = `${RECORD}
process.stdout.write(${JSON.stringify(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ignored", structured_output: { output: select } }))});`;
  await withBroker(ANTHROPIC, { executable: (root) => fakeCli(root, body) }, async (broker) => {
    const answer = await broker.call(launchLine(broker.fixture));
    const raw = JSON.stringify(select);
    assert.deepEqual(answer, {
      v: 1,
      type: "result",
      requestId: REQUEST_ID,
      instance: ANTHROPIC,
      transmission: "process_ended",
      result: { kind: "output", raw },
      resultDigest: dmResultDigest(REQUEST_KEY, { kind: "output", raw }),
      launch: { outcome: "output", reasons: [] },
      cleanup: VERIFIED,
    });
    // The process received the exact bytes the intent recorded, in the vendor account's copy of the broker's directory.
    const stdin = readFileSync(broker.fixture.at("/observed/stdin"));
    assert.deepEqual(stdin, PAYLOAD);
    assert.equal(dmPayloadDigest(REQUEST_KEY, stdin), broker.fixture.evidence.inputPayloadDigest);
    assert.equal(
      readFileSync(broker.fixture.at("/observed/cwd"), "utf8"),
      broker.fixture.at(dmRequestPaths(ANTHROPIC, REQUEST_ID).workDirectory),
    );
    assert.equal(existsSync(broker.requestDirectory()), false);
    assert.equal(existsSync(broker.fixture.at(dmRequestPaths(ANTHROPIC, REQUEST_ID).temporaryDirectory)), false);
    // claude's JSON result carries no tool events, so there is nothing to count; the request has no repo/ to install.
    assert.deepEqual(broker.served, [{
      answered: "launched", requestId: REQUEST_ID, outcome: "output", cleanup: "verified", tools: null,
      dependencies: { proc: false, trees: {} },
    }]);
    // The broker's log has codes, not the output, the payload or the key.
    const logged = JSON.stringify(broker.logs);
    assert.equal(broker.logs.length, 1);
    for (const secret of ["Smaller change", PAYLOAD.toString("base64"), REQUEST_KEY.toString("hex")]) {
      assert.equal(logged.includes(secret), false, secret);
    }
  });
});

test("a DM process that fails is DM 불가 after it ran; the directory is still deleted", { skip: !posix }, async () => {
  const body = `${RECORD}
process.stdout.write(${JSON.stringify(JSON.stringify({ type: "result", is_error: true }))});
process.exitCode = 1;`;
  await withBroker(ANTHROPIC, { executable: (root) => fakeCli(root, body) }, async (broker) => {
    const answer = await broker.call(launchLine(broker.fixture));
    assert.equal(answer.transmission, "process_ended");
    assert.deepEqual(answer.launch, { outcome: "unavailable", reasons: ["exit_code_1"] });
    assert.deepEqual(answer.result, { kind: "unavailable" });
    assert.deepEqual(answer.cleanup, VERIFIED);
    assert.equal(existsSync(broker.requestDirectory()), false);
  });
});

test("§5 hard timeout through the broker: a process that never ends is killed and reported as a timeout", { skip: !posix }, async () => {
  const body = `${RECORD}
setInterval(() => {}, 1000);`;
  await withBroker(OPENAI, { executable: (root) => fakeCli(root, body), launchTimeoutMs: 500 }, async (broker) => {
    const answer = await broker.call(launchLine(broker.fixture));
    assert.equal(answer.transmission, "process_ended");
    assert.deepEqual(answer.result, { kind: "timeout" });
    assert.deepEqual(answer.cleanup, VERIFIED);
    assert.equal(existsSync(broker.requestDirectory()), false);
  });
});

// ---------------------------------------------------------------------------
// The system host
// ---------------------------------------------------------------------------

test("on the system host the launcher sockets and the deadlines are fixed", () => {
  assert.throws(() => createDecisionMakerBroker({ connectLauncher: () => null }), /fixed on the system host/);
  assert.throws(() => createDecisionMakerBroker({ timeouts: { launcherResponse: 1 } }), /fixed on the system host/);
  assert.doesNotThrow(() => createDecisionMakerBroker({ log: () => {} }));
});

test("the broker listens only on the one socket systemd passed this process", () => {
  assert.equal(dmSystemdListenFd({ LISTEN_PID: "42", LISTEN_FDS: "1" }, 42), 3);
  assert.equal(dmSystemdListenFd({ LISTEN_PID: "41", LISTEN_FDS: "1" }, 42), null);
  assert.equal(dmSystemdListenFd({ LISTEN_PID: "42", LISTEN_FDS: "2" }, 42), null);
  assert.equal(dmSystemdListenFd({}, 42), null);
});

// ---------------------------------------------------------------------------
// The workspace (owner decision 2026-11-15; it replaced stage S2b's snapshot)
// ---------------------------------------------------------------------------

const enc = (value) => new TextEncoder().encode(value);
const WORKSPACE_SHA = "0123456789abcdef0123456789abcdef01234567";
/** A patch far past the 4,000 characters a card's context once held. */
const BIG_PATCH = `diff --git a/docs/store.md b/docs/store.md\n--- a/docs/store.md\n+++ b/docs/store.md\n@@ -1 +1,20001 @@\n SQLite is the store.\n${"+line of a long patch\n".repeat(20_000)}`;

const publicReads = (reads) => async (url) => {
  reads.push(url);
  if (url.endsWith("/commits/develop") || url.endsWith(`/commits/${WORKSPACE_SHA}`)) {
    return { status: 200, body: enc(JSON.stringify({ sha: WORKSPACE_SHA })) };
  }
  return { status: 404, body: enc("") };
};

test("a workspace request is answered from the public reads alone -- no directory, no launcher -- and a secret file is left out", async () => {
  const reads = [];
  await withBroker(OPENAI, { launcher: "absent", workspaceHttp: publicReads(reads) }, async (broker) => {
    const files = [
      { name: "PATCH.diff", content: Buffer.from(BIG_PATCH).toString("base64") },
      { name: "FINDINGS.md", content: Buffer.from(`token ghp_${"a".repeat(36)}\n`).toString("base64") },
    ];
    const answer = await broker.call({ v: 1, type: "workspace", requestId: REQUEST_ID, targetSha: null, files });
    assert.equal(answer.type, "workspace");
    assert.equal(answer.requestId, REQUEST_ID);
    assert.deepEqual([answer.state, answer.targetSha, answer.reason], ["develop", WORKSPACE_SHA, null]);
    assert.deepEqual(answer.files, ["PATCH.diff"]);
    assert.deepEqual(answer.excluded, { secret_content: 1 });
    const lines = Buffer.from(answer.lines, "base64").toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines[0], { workspace: { repository: "github.com/mposition/Tomverse", commit: WORKSPACE_SHA, state: "develop", patch: true, files: 1 } });
    // The patch is named by its blob id and size; its text is never in the lines.
    assert.deepEqual(lines[1], { file: "evidence/PATCH.diff", blob: gitBlobId(enc(BIG_PATCH)), bytes: Buffer.byteLength(BIG_PATCH) });
    assert.ok(Buffer.from(answer.lines, "base64").length < 1024);
    // Only the public API's commit lookups, nothing else.
    assert.ok(reads.every((url) => url.startsWith("https://api.github.com/repos/mposition/Tomverse/commits/")), reads.join());
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
    // A malformed request is answered with no workspace, not a launch.
    const malformed = await broker.call({ v: 1, type: "workspace", requestId: "nope", targetSha: null, files: [] });
    assert.deepEqual([malformed.state, malformed.reason, malformed.lines], ["none", "request_malformed", ""]);
  });
});

/** A launch whose payload ends with the workspace's lines, and the intent for those bytes. */
const workspaceLaunch = (broker, workspace) => {
  const payload = Buffer.concat([PAYLOAD, Buffer.from(dmWorkspacePayloadLines(workspace), "utf8")]);
  return launchLine(broker.fixture, {
    payload: payload.toString("base64"),
    transmitIntent: { ...broker.fixture.evidence, inputPayloadDigest: dmPayloadDigest(REQUEST_KEY, payload) },
    workspace: dmEncodeLaunchWorkspace(workspace),
  });
};

const gitExecutable = (() => {
  try {
    // The workspace keeps the system host's Linux PATH even on a test host.
    const executable = process.platform === "win32"
      ? execFileSync("where.exe", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
      : "git";
    execFileSync(executable, ["--version"], { stdio: "ignore" });
    return executable;
  } catch {
    return null;
  }
})();

/** A local repository with one commit, standing in for GitHub; fetched over file:// like the real one over https. */
const localRepository = (root) => {
  const repo = join(root, "origin");
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync(gitExecutable, ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "store.md"), "SQLite is the store.\n");
  git("add", ".");
  git("commit", "-q", "-m", "store");
  return { url: pathToFileURL(repo).href, sha: git("rev-parse", "HEAD") };
};

test("a launch builds the workspace: the checkout, the patch applied, every evidence byte, read by the launcher, then deleted", { skip: !gitExecutable && "git is not installed" }, async () => {
  const seen = [];
  const launcher = scripted(OPENAI, async (socket, request, fixture) => {
    const base = fixture.at(fixture.paths.requestDirectory);
    seen.push({
      entries: readdirSync(base).sort(),
      patch: readFileSync(join(base, "evidence", "PATCH.diff"), "utf8"),
      before: readFileSync(join(base, "repo", "docs", "store.md"), "utf8"),
      after: readFileSync(join(base, "repo-patched", "docs", "store.md"), "utf8"),
      guide: readFileSync(join(base, "WORKSPACE.md"), "utf8"),
      request,
    });
    await dmWriteLine(socket, dmEncodeLauncherLaunched(request, { outcome: "timeout" }, VERIFIED), 2_000);
    socket.end();
  });
  const probe = makeTempRoot();
  const origin = localRepository(probe);
  try {
    await withBroker(OPENAI, { launcher, workspaceGit: { executable: gitExecutable, cloneUrl: origin.url } }, async (broker) => {
      const workspace = { state: "worker_head", targetSha: origin.sha, files: [{ name: "PATCH.diff", text: BIG_PATCH }] };
      const answer = await broker.call(workspaceLaunch(broker, workspace));
      assert.equal(answer.transmission, "process_ended", JSON.stringify(broker.logs.at(-1)));
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].entries, ["WORKSPACE.md", "evidence", "repo", "repo-patched"]);
      // The whole patch, not a card's worth of it.
      assert.equal(seen[0].patch, BIG_PATCH);
      assert.equal(seen[0].before, "SQLite is the store.\n");
      // The one line it had, the 20,000 the patch adds, and the end.
      assert.equal(seen[0].after.split("\n").length, 20_002);
      assert.match(seen[0].guide, new RegExp(`repo/ is a checkout of commit ${origin.sha}`));
      assert.match(seen[0].guide, /repo-patched\/ is the same commit with evidence\/PATCH\.diff applied/);
      // The launcher gets the seven keys: never the workspace's evidence.
      assert.equal(Object.hasOwn(seen[0].request, "workspace"), false);
      // §5: deleted on the way out, whatever the tree held.
      assert.deepEqual(answer.cleanup, VERIFIED);
      assert.equal(existsSync(broker.requestDirectory()), false);
      assert.match(broker.logs.at(-1).workspace, /^built:applied$/);
    });
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test("a launch whose workspace is not the one its payload names is refused before anything is made", async () => {
  await withBroker(OPENAI, {}, async (broker) => {
    const workspace = { state: "develop", targetSha: WORKSPACE_SHA, files: [{ name: "PATCH.diff", text: "diff --git a/x b/x\n+x\n" }] };
    const named = workspaceLaunch(broker, workspace);
    const other = { ...named, workspace: dmEncodeLaunchWorkspace({ ...workspace, files: [{ name: "PATCH.diff", text: "diff --git a/y b/y\n+y\n" }] }) };
    for (const line of [other, { ...named, workspace: null }]) {
      const answer = await broker.call(line);
      assert.deepEqual(answer.launch, { outcome: "broker_refused", reasons: ["workspace_mismatch"] });
      assert.equal(answer.transmission, "not_started");
    }
    // A payload with no workspace line and a workspace in the launch.
    const card = launchLine(broker.fixture, { workspace: dmEncodeLaunchWorkspace(workspace) });
    assert.deepEqual((await broker.call(card)).launch, { outcome: "broker_refused", reasons: ["workspace_mismatch"] });
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
  });
});

test("a workspace that cannot be fetched is refused: nothing is sent, and the directory is gone", { skip: !gitExecutable && "git is not installed" }, async () => {
  const probe = makeTempRoot();
  try {
    await withBroker(OPENAI, { workspaceGit: { executable: gitExecutable, cloneUrl: pathToFileURL(join(probe, "missing")).href } }, async (broker) => {
      const workspace = { state: "develop", targetSha: WORKSPACE_SHA, files: [] };
      const answer = await broker.call(workspaceLaunch(broker, workspace));
      assert.deepEqual(answer.launch, { outcome: "broker_refused", reasons: ["workspace_unavailable"] });
      assert.equal(answer.transmission, "not_started");
      assert.deepEqual(answer.cleanup, VERIFIED);
      assert.equal(broker.launcherConnections.length, 0);
      assert.equal(existsSync(broker.requestDirectory()), false);
      assert.equal(broker.logs.at(-1).workspace, "failed:git_failed:fetch");
    });
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test("the workspace's git runs with no credential, no config file and https only; the public reads go to the API alone", async () => {
  const environment = dmWorkspaceSystemGitEnvironment("/var/lib/amux-dm/requests/x");
  assert.deepEqual(Object.keys(environment).sort(),
    ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "LC_ALL", "PATH"]);
  assert.ok(!Object.keys(environment).some((name) => /TOKEN|SECRET|KEY|PASSWORD|GH_|GITHUB|ASKPASS|SSH|PROXY/i.test(name)));
  assert.equal(environment.PATH, "/usr/bin:/bin");
  for (const flag of ["credential.helper=", "core.askPass=", "protocol.allow=never", "protocol.https.allow=always", "http.followRedirects=false", "core.symlinks=false"]) {
    assert.ok(DM_WORKSPACE_GIT_FLAGS.includes(flag), flag);
  }
  assert.ok(!DM_WORKSPACE_GIT_FLAGS.some((flag) => flag.startsWith("protocol.file")), "file:// is a test host's only");
  // Only https to api.github.com: anything else is refused without a request.
  for (const url of ["https://raw.githubusercontent.com/mposition/Tomverse/x", "http://api.github.com/repos/mposition/Tomverse/commits/develop", "https://example.invalid/"]) {
    assert.equal(await dmWorkspaceHttpClient(url), null, url);
  }
  // A system host never takes another git or repository.
  await assert.rejects(
    buildDmWorkspace(DM_SYSTEM_HOST, { instance: OPENAI, requestId: REQUEST_ID, groupId: null,
      workspace: { state: "none", targetSha: null, files: [] } }, { git: { executable: "git", cloneUrl: "file:///x" } }),
    /fixed on the system host/);
});

test("the build measures the directory as git writes into it: every regular file's bytes, nothing else", async () => {
  const { dmWorkspaceBytes, DM_WORKSPACE_DISK_CHECK_MS } = await import("../lib/amux/decisionMakerWorkspaceBuild.ts");
  const probe = makeTempRoot();
  try {
    mkdirSync(join(probe, "a", "b"), { recursive: true });
    writeFileSync(join(probe, "a", "one"), "x".repeat(1000));
    writeFileSync(join(probe, "a", "b", "two"), "y".repeat(24));
    assert.equal(dmWorkspaceBytes(probe), 1024);
    assert.equal(dmWorkspaceBytes(join(probe, "missing")), 0, "a directory that is gone counts nothing and never throws");
    assert.ok(DM_WORKSPACE_DISK_CHECK_MS <= 1_000, "checked at least every second while git runs");
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The parts protocol (docs/policy/amux-v22-result-transfer.md 10.2): evidence
// of any size reaches the broker as chunks on the launch's connection.
// ---------------------------------------------------------------------------

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/** Past the 64 MiB the inline protocol held, and valid text all the way. */
const HUGE_PATCH = (() => {
  const line = "+a line of a patch far past the old evidence cap\n";
  return `diff --git a/a b/a\n${line.repeat(Math.ceil((DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES + 1024 * 1024) / line.length))}`;
})();

/**
 * A launch whose workspace is named by description. `files` is what the bridge will send
 * (`name`, `text`); `named` is what the payload's lines name (default: the same).
 */
const partsLaunch = (broker, files, { named = files, state = "none", targetSha = null } = {}) => {
  const payload = Buffer.concat([PAYLOAD, Buffer.from(dmWorkspacePayloadLines({ state, targetSha, files: named }), "utf8")]);
  return launchLine(broker.fixture, {
    payload: payload.toString("base64"),
    transmitIntent: { ...broker.fixture.evidence, inputPayloadDigest: dmPayloadDigest(REQUEST_KEY, payload) },
    workspace: dmEncodeLaunchWorkspaceParts({
      state,
      targetSha,
      parts: files.map((file) => ({ name: file.name, bytes: Buffer.byteLength(file.text), sha256: sha256Hex(file.text) })),
    }),
  });
};
const bytesOf = (files) => new Map(files.map((file) => [file.name, Buffer.from(file.text, "utf8")]));
const SMALL = "diff --git a/x b/x\n+x\n";

test("a workspace request in the parts protocol is answered from the descriptions alone: no bytes, no directory, no launcher", async () => {
  const reads = [];
  await withBroker(OPENAI, { launcher: "absent", workspaceHttp: publicReads(reads) }, async (broker) => {
    const part = (name, text) => ({ name, bytes: Buffer.byteLength(text), sha256: sha256Hex(text), blob: gitBlobId(enc(text)) });
    const parts = [part("PATCH.diff", HUGE_PATCH), part("FINDINGS.md", "the report\n"), { ...part("CONTEXT.md", "x"), name: ".env" }];
    const answer = await broker.call({ v: 1, type: "workspace", requestId: REQUEST_ID, targetSha: null, parts });
    assert.deepEqual([answer.type, answer.state, answer.targetSha], ["workspace", "develop", WORKSPACE_SHA]);
    assert.deepEqual(answer.files, ["PATCH.diff", "FINDINGS.md"]);
    assert.deepEqual(answer.excluded, { name_refused: 1 });
    const lines = Buffer.from(answer.lines, "base64").toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines[1], { file: "evidence/PATCH.diff", blob: gitBlobId(enc(HUGE_PATCH)), bytes: Buffer.byteLength(HUGE_PATCH) });
    assert.ok(Buffer.byteLength(HUGE_PATCH) > DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES);
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
  });
});

test("a file past the old 64 MiB cap arrives in chunks, is checked whole, and is written whole for the launcher", async () => {
  const seen = [];
  const launcher = scripted(OPENAI, async (socket, request, fixture) => {
    const base = fixture.at(fixture.paths.requestDirectory);
    const written = readFileSync(join(base, "evidence", "PATCH.diff"));
    seen.push({ bytes: written.length, sha256: sha256Hex(written), findings: readFileSync(join(base, "evidence", "FINDINGS.md"), "utf8") });
    await dmWriteLine(socket, dmEncodeLauncherLaunched(request, { outcome: "timeout" }, VERIFIED), 2_000);
    socket.end();
  });
  await withBroker(OPENAI, { launcher }, async (broker) => {
    const files = [{ name: "PATCH.diff", text: HUGE_PATCH }, { name: "FINDINGS.md", text: "the report\n" }];
    const { answer, transcript } = await broker.callParts(partsLaunch(broker, files), bytesOf(files));
    assert.equal(answer.type, "result", JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.transmission, "process_ended", JSON.stringify(broker.logs.at(-1)));
    assert.deepEqual(seen, [{ bytes: Buffer.byteLength(HUGE_PATCH), sha256: sha256Hex(HUGE_PATCH), findings: "the report\n" }]);
    // send_parts first, then one part_stored per chunk (the patch's, then the report's one), then the result.
    assert.equal(transcript[0].type, "send_parts");
    assert.ok(transcript.slice(1, -1).every((line) => line.type === "part_stored"));
    assert.equal(transcript.length, 1 + Math.ceil(Buffer.byteLength(HUGE_PATCH) / (4 * 1024 * 1024)) + 1 + 1);
    assert.deepEqual(answer.cleanup, VERIFIED);
    assert.equal(existsSync(broker.requestDirectory()), false);
    assert.equal(broker.logs.at(-1).workspace, "built:not_applied", "a patch with no checkout to apply to");
  });
});

test("the secret scan still holds the whole file: one past the 64 MiB mark refuses the workspace before anything is made", async () => {
  const token = ["gh", "p_", "Q".repeat(36)].join("");
  await withBroker(OPENAI, {}, async (broker) => {
    const files = [{ name: "PATCH.diff", text: `${HUGE_PATCH}+${token}\n` }];
    const { answer } = await broker.callParts(partsLaunch(broker, files), bytesOf(files));
    assert.deepEqual(answer.launch, { outcome: "broker_refused", reasons: ["workspace_mismatch"] });
    assert.equal(answer.transmission, "not_started");
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
  });
});

test("bytes that are not what the launch described are refused: another sha256, an out-of-order chunk, a payload that names other files", async () => {
  await withBroker(OPENAI, {}, async (broker) => {
    const files = [{ name: "PATCH.diff", text: SMALL.repeat(400_000) }];
    const refusal = (result) => assert.deepEqual([result.answer.launch, result.answer.transmission],
      [{ outcome: "broker_refused", reasons: ["workspace_mismatch"] }, "not_started"]);
    const line = partsLaunch(broker, files);
    // A byte changed in transit: the whole file's sha256 differs.
    const flipped = Buffer.from(files[0].text, "utf8");
    flipped[1000] ^= 1;
    refusal(await broker.callParts(line, new Map([["PATCH.diff", flipped]])));
    // The second chunk sent first.
    refusal(await broker.callParts(line, bytesOf(files), {
      plan: (name, index, chunk) => dmEncodePartLine(REQUEST_ID, name, index === 0 ? 1 : index, chunk),
    }));
    // A chunk of another request.
    refusal(await broker.callParts(line, bytesOf(files), {
      plan: (name, index, chunk) => dmEncodePartLine("0a1b2c3d-4e5f-4a6b-8c7d-000000000002", name, index, chunk),
    }));
    // Bytes that match their description but not the payload the intent recorded.
    const other = [{ name: "PATCH.diff", text: "diff --git a/y b/y\n+y\n" }];
    refusal(await broker.callParts(partsLaunch(broker, other, { named: files }), bytesOf(other)));
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
    assert.equal(broker.broker.inFlight().size, 0);
  });
});

test("an abort, a bridge that goes quiet and one that goes away end the request with nothing made and the broker free", async () => {
  await withBroker(OPENAI, { timeouts: { workspace: 1500 } }, async (broker) => {
    const files = [{ name: "PATCH.diff", text: SMALL.repeat(500_000) }];
    const line = partsLaunch(broker, files);
    const unavailable = (result) => assert.deepEqual([result.answer.launch, result.answer.transmission],
      [{ outcome: "broker_refused", reasons: ["workspace_unavailable"] }, "not_started"]);
    // The bridge could not get a chunk: it says so, and the broker answers.
    unavailable(await broker.callParts(line, bytesOf(files), { plan: (name, index) => (index === 1 ? "abort" : undefined) }));
    // The bridge stops after the first chunk and the workspace's time ends.
    unavailable(await broker.callParts(line, bytesOf(files), { plan: (name, index) => (index === 1 ? "stop" : undefined) }));
    // The bridge hangs up: nothing to answer to, and nothing left behind.
    const gone = await broker.callParts(line, bytesOf(files), { plan: (name, index) => (index === 1 ? "stop" : undefined), hangUp: true });
    assert.equal(gone.answer.error, "bridge_gone");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(broker.broker.inFlight().size, 0);
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
    // And the next request is served.
    const next = await broker.call(launchLine(broker.fixture, { transmitIntent: null }));
    assert.deepEqual(next.launch, { outcome: "broker_refused", reasons: ["transmit_intent_missing"] });
  });
});

test("without the recorded intent no chunk is asked for: the refusal is the first answer", async () => {
  await withBroker(OPENAI, {}, async (broker) => {
    const files = [{ name: "PATCH.diff", text: SMALL }];
    const line = { ...partsLaunch(broker, files), transmitIntent: null };
    const { answer, transcript } = await broker.callParts(line, bytesOf(files));
    assert.deepEqual(answer.launch, { outcome: "broker_refused", reasons: ["transmit_intent_missing"] });
    assert.deepEqual(transcript.map((entry) => entry.type), ["result"]);
  });
});

test("a launch with no workspace but a payload that names one is still refused, and a request that arrives while one receives is refused busy", async () => {
  await withBroker(OPENAI, {}, async (broker) => {
    const inline = { state: "none", targetSha: null, files: [{ name: "PATCH.diff", text: SMALL }] };
    const mismatch = await broker.call({ ...workspaceLaunch(broker, inline), workspace: null });
    assert.deepEqual(mismatch.launch, { outcome: "broker_refused", reasons: ["workspace_mismatch"] });
    // One request is mid-receive when another arrives for the same instance.
    const files = [{ name: "PATCH.diff", text: SMALL.repeat(500_000) }];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = broker.callParts(partsLaunch(broker, files), bytesOf(files), {
      plan: async (name, index, chunk) => {
        if (index === 1) await gate;
        return dmEncodePartLine(REQUEST_ID, name, index, chunk);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const busy = await broker.call(launchLine(broker.fixture, { requestId: "0a1b2c3d-4e5f-4a6b-8c7d-000000000002" }));
    assert.deepEqual(busy.launch, { outcome: "broker_refused", reasons: ["busy"] });
    release();
    await slow;
  });
});
