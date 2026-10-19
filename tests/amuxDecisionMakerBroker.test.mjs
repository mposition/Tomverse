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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import test from "node:test";

import { createDecisionMakerBroker, dmSystemdListenFd } from "../lib/amux/decisionMakerBroker.ts";
import { dmEncodeLauncherLaunched, dmEncodeLauncherReady } from "../lib/amux/decisionMakerBrokerCore.ts";
import { dmPayloadDigest, dmResultDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import { DM_REQUEST_ROOT } from "../lib/amux/decisionMakerLauncherCore.ts";
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
    // The process received the exact bytes the intent recorded, in the broker's directory.
    const stdin = readFileSync(broker.fixture.at("/observed/stdin"));
    assert.deepEqual(stdin, PAYLOAD);
    assert.equal(dmPayloadDigest(REQUEST_KEY, stdin), broker.fixture.evidence.inputPayloadDigest);
    assert.equal(readFileSync(broker.fixture.at("/observed/cwd"), "utf8"), broker.requestDirectory());
    assert.equal(existsSync(broker.requestDirectory()), false);
    assert.deepEqual(broker.served, [{ answered: "launched", outcome: "output", cleanup: "verified" }]);
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

test("stage S2b: a snapshot request is answered from the public reads alone -- no directory, no launcher", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const text = "SQLite is the store.\n";
  const { gitBlobId } = await import("../lib/amux/decisionMakerSnapshot.ts");
  const enc = (value) => new TextEncoder().encode(value);
  const reads = [];
  const snapshotHttp = async (url) => {
    reads.push(url);
    if (url.endsWith("/commits/develop") || url.endsWith(`/commits/${sha}`)) return { status: 200, body: enc(JSON.stringify({ sha })) };
    if (url.includes("/git/trees/")) return { status: 200, body: enc(JSON.stringify({ truncated: false, tree: [{ path: "docs/store.md", mode: "100644", type: "blob", sha: gitBlobId(enc(text)) }] })) };
    if (url.endsWith("/docs/store.md")) return { status: 200, body: enc(text) };
    return { status: 404, body: enc("") };
  };
  await withBroker(OPENAI, { launcher: "absent", snapshotHttp }, async (broker) => {
    const answer = await broker.call({ v: 1, type: "snapshot", requestId: REQUEST_ID, paths: ["docs/store.md", ".env"] });
    assert.equal(answer.type, "snapshot");
    assert.equal(answer.requestId, REQUEST_ID);
    assert.equal(answer.state, "develop");
    assert.equal(answer.targetSha, sha);
    assert.deepEqual(answer.excluded, { secret_path: 1 });
    const lines = Buffer.from(answer.lines, "base64").toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines[1], { file: "docs/store.md", blob: gitBlobId(enc(text)), text });
    assert.equal(broker.launcherConnections.length, 0);
    assert.equal(existsSync(broker.requestDirectory()), false);
    // A malformed snapshot request is answered with no snapshot, not a launch.
    const malformed = await broker.call({ v: 1, type: "snapshot", requestId: "nope", paths: [] });
    assert.deepEqual([malformed.state, malformed.reason, malformed.lines], ["none", "request_malformed", ""]);
  });
});
