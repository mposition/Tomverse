// The AMUX Decision Maker broker's socket protocols, stage S2-3b
// (docs/policy/amux-decision-maker.md policy version 2, §2-4, §2-5, §5, §9,
// §10): the strict line format, what each side accepts, how a launcher's
// answer becomes the broker's answer to the bridge, and the line reader's
// caps and deadlines. Pure; nothing starts and nothing is sent.

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { dmPayloadDigest, dmResultDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import {
  DM_BROKER_RESPONSE_DEADLINE_MS,
  DM_BROKER_SOCKET_PATH,
  DM_LAUNCHER_RESPONSE_TIMEOUT_MS,
  DM_LAUNCHER_SOCKET_PATHS,
  DM_LAUNCHER_UNIT_RUNTIME_MAX_MS,
  DM_LAUNCH_LINE_MAX_BYTES,
  DM_PART_LINE_MAX_BYTES,
  DM_PAYLOAD_MAX_BYTES,
  DM_RESULT_LINE_MAX_BYTES,
  dmBrokerAnswer,
  dmDecodeBase64,
  dmEncodeAbortLine,
  dmEncodeLaunchRequest,
  dmEncodePartLine,
  dmEncodePartStored,
  dmEncodeSendParts,
  dmParsePartLine,
  dmEncodeLauncherLaunched,
  dmEncodeLauncherReady,
  dmEncodeLauncherRejected,
  dmLauncherReadyFits,
  dmLauncherRequestError,
  dmParseLaunchRequest,
  dmParseLauncherAnswer,
  dmTransmissionOf,
} from "../lib/amux/decisionMakerBrokerCore.ts";
import {
  DM_LAUNCH_OUTPUT_MAX_BYTES,
  DM_LAUNCH_REFUSALS,
  DM_LAUNCH_UNAVAILABLE_REASONS,
} from "../lib/amux/decisionMakerLauncherCore.ts";
import { DM_LAUNCH_HARD_TIMEOUT_MS } from "../lib/amux/decisionMakerLauncherProcess.ts";
import { AMUX_V22_TRANSFER_CHUNK_BYTES } from "../lib/amux/v22TransferCore.ts";
import { dmReadLine, dmWriteLine } from "../lib/amux/decisionMakerSocketLine.ts";
import { EVENT_ID, PAYLOAD, REQUEST_ID, REQUEST_KEY } from "./support/amuxDmLauncherFixture.mjs";

const OPENAI = "decision-maker-openai";
const ANTHROPIC = "decision-maker-anthropic";

const evidence = {
  requestId: REQUEST_ID,
  instance: OPENAI,
  recorded: true,
  eventId: EVENT_ID,
  inputPayloadDigest: dmPayloadDigest(REQUEST_KEY, PAYLOAD),
};

const launch = (overrides = {}) => ({
  v: 1,
  type: "launch",
  requestId: REQUEST_ID,
  instance: OPENAI,
  requestKey: REQUEST_KEY.toString("hex"),
  payload: PAYLOAD.toString("base64"),
  transmitIntent: evidence,
  ...overrides,
});

const line = (value) => JSON.stringify(value);

// ---------------------------------------------------------------------------
// Fixed values
// ---------------------------------------------------------------------------

test("the sockets are systemd's fixed paths, one per launcher instance", () => {
  assert.equal(DM_BROKER_SOCKET_PATH, "/run/amux-dm-broker/broker.sock");
  assert.deepEqual(DM_LAUNCHER_SOCKET_PATHS, {
    "decision-maker-openai": "/run/amux-dm-launcher/decision-maker-openai.sock",
    "decision-maker-anthropic": "/run/amux-dm-launcher/decision-maker-anthropic.sock",
  });
});

test("§5 hard timeout: each deadline outlasts the one inside it, so no answer can follow a give-up", () => {
  // Owner direction 2026-11-16: two hours, and the unit two minutes more.
  assert.equal(DM_LAUNCH_HARD_TIMEOUT_MS, 2 * 60 * 60 * 1000);
  assert.equal(DM_LAUNCHER_UNIT_RUNTIME_MAX_MS, 122 * 60 * 1000);
  assert.equal(DM_BROKER_RESPONSE_DEADLINE_MS, 184 * 60 * 1000);
  assert.ok(DM_LAUNCH_HARD_TIMEOUT_MS < DM_LAUNCHER_UNIT_RUNTIME_MAX_MS);
  assert.ok(DM_LAUNCHER_UNIT_RUNTIME_MAX_MS < DM_LAUNCHER_RESPONSE_TIMEOUT_MS);
  assert.ok(DM_LAUNCHER_RESPONSE_TIMEOUT_MS < DM_BROKER_RESPONSE_DEADLINE_MS);
});

test("the caps hold the largest payload and the largest output with their encodings", () => {
  // base64 is 4/3 of the payload; the rest of a launch line is a few hundred bytes.
  assert.ok(Math.ceil(DM_PAYLOAD_MAX_BYTES / 3) * 4 + 1024 < DM_LAUNCH_LINE_MAX_BYTES);
  // A JSON string spends at most six bytes on one input byte.
  assert.ok(DM_LAUNCH_OUTPUT_MAX_BYTES * 6 + 4096 < DM_RESULT_LINE_MAX_BYTES);
  const largest = launch({ payload: Buffer.alloc(DM_PAYLOAD_MAX_BYTES, 0xff).toString("base64") });
  assert.ok(Buffer.byteLength(line(largest)) < DM_LAUNCH_LINE_MAX_BYTES);
});

// ---------------------------------------------------------------------------
// `launch`
// ---------------------------------------------------------------------------

test("a launch line round-trips through the strict parse with the exact payload bytes", () => {
  const parsed = dmParseLaunchRequest(line(launch()));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.request.requestId, REQUEST_ID);
  assert.equal(parsed.request.instance, OPENAI);
  assert.deepEqual(parsed.request.requestKey, REQUEST_KEY);
  assert.deepEqual(parsed.request.payload, PAYLOAD);
  assert.deepEqual(parsed.request.transmitIntent, evidence);
  assert.deepEqual(dmEncodeLaunchRequest(parsed.request), launch());
});

test("anything but exactly the launch shape is refused, naming what could be read", () => {
  const missing = Object.fromEntries(Object.entries(launch()).filter(([key]) => key !== "transmitIntent"));
  for (const bad of ["", "not json", "[]", "null", line({ ...launch(), extra: 1 }), line(missing), line(launch({ v: 2 })), line(launch({ type: "prepare" }))]) {
    const parsed = dmParseLaunchRequest(bad);
    assert.equal(parsed.ok, false, bad);
    assert.equal(parsed.refusal, "request_malformed", bad);
  }
  assert.deepEqual(
    { ...dmParseLaunchRequest(line(launch({ requestId: "../x" }))), requestKey: null },
    { ok: false, refusal: "request_id_invalid", requestId: null, instance: OPENAI, requestKey: null },
  );
  const unknown = dmParseLaunchRequest(line(launch({ instance: "decision-maker-gemini" })));
  assert.equal(unknown.refusal, "instance_unknown");
  assert.equal(unknown.requestId, REQUEST_ID);
  for (const requestKey of ["AB".repeat(32), "ab".repeat(31), "ab".repeat(33), REQUEST_KEY.toString("base64"), 7]) {
    const parsed = dmParseLaunchRequest(line(launch({ requestKey })));
    assert.equal(parsed.refusal, "request_key_invalid", String(requestKey));
    assert.equal(parsed.instance, OPENAI);
  }
});

test("the payload is canonical base64, not empty, within the cap", () => {
  const exact = PAYLOAD.toString("base64");
  for (const payload of ["", exact.slice(0, -1), "QQ", `${exact}\n`, ` ${exact}`, `*${exact.slice(1)}`, 5, null]) {
    const parsed = dmParseLaunchRequest(line(launch({ payload })));
    assert.equal(parsed.refusal, "payload_invalid", JSON.stringify(payload));
    assert.deepEqual(parsed.requestKey, REQUEST_KEY, "the key is read, so the refusal can carry a result digest");
  }
  // "QR==" decodes to the same byte as "QQ==": only the canonical text is the payload.
  assert.equal(dmDecodeBase64("QR==", 10), null);
  assert.deepEqual(dmDecodeBase64("QQ==", 10), Buffer.from("A"));
  assert.equal(dmDecodeBase64(Buffer.alloc(DM_PAYLOAD_MAX_BYTES + 1).toString("base64"), DM_PAYLOAD_MAX_BYTES), null);
  assert.ok(dmDecodeBase64(Buffer.alloc(DM_PAYLOAD_MAX_BYTES).toString("base64"), DM_PAYLOAD_MAX_BYTES));
});

test("a launcher runs only its own instance's request", () => {
  assert.equal(dmLauncherRequestError(dmParseLaunchRequest(line(launch())), OPENAI), null);
  assert.equal(dmLauncherRequestError(dmParseLaunchRequest(line(launch())), ANTHROPIC), "instance_mismatch");
  assert.equal(dmLauncherRequestError(dmParseLaunchRequest(line(launch({ instance: "x" }))), OPENAI), "instance_mismatch");
  assert.equal(dmLauncherRequestError(dmParseLaunchRequest("{}"), OPENAI), "request_malformed");
});

// ---------------------------------------------------------------------------
// `ready` and the launcher's answer
// ---------------------------------------------------------------------------

test("ready names the launcher's instance; any other line is not ready", () => {
  assert.equal(dmLauncherReadyFits(line(dmEncodeLauncherReady(OPENAI)), OPENAI), true);
  assert.equal(dmLauncherReadyFits(line(dmEncodeLauncherReady(ANTHROPIC)), OPENAI), false);
  assert.equal(dmLauncherReadyFits(line({ ...dmEncodeLauncherReady(OPENAI), extra: true }), OPENAI), false);
  assert.equal(dmLauncherReadyFits("ready", OPENAI), false);
});

const sent = { requestId: REQUEST_ID, instance: OPENAI };
const VERIFIED = { status: "verified" };

test("a launched answer is held to the launcher's closed vocabularies and caps", () => {
  const results = [
    { outcome: "output", raw: '{"kind":"escalate","reason":"r"}' },
    { outcome: "timeout" },
    ...DM_LAUNCH_UNAVAILABLE_REASONS.map((reason) => ({ outcome: "unavailable", reason })),
    { outcome: "refused", refusals: [...DM_LAUNCH_REFUSALS] },
  ];
  for (const result of results) {
    const answer = dmParseLauncherAnswer(line(dmEncodeLauncherLaunched(sent, result, VERIFIED)), sent);
    assert.deepEqual(answer, { type: "launched", result, cleanup: VERIFIED });
  }
  const wire = (result, cleanup = VERIFIED, extra = {}) => line({ ...dmEncodeLauncherLaunched(sent, result, cleanup), ...extra });
  const rejected = [
    wire({ outcome: "output", raw: "x".repeat(DM_LAUNCH_OUTPUT_MAX_BYTES + 1) }),
    wire({ outcome: "output", raw: 7 }),
    wire({ outcome: "refused", refusals: [] }),
    wire({ outcome: "refused", refusals: ["made_up"] }),
    wire({ outcome: "unavailable", reason: "made_up" }),
    wire({ outcome: "timeout", raw: "x" }),
    wire({ outcome: "done" }),
    wire({ outcome: "timeout" }, { status: "cleanup_unknown", residue: [] }),
    wire({ outcome: "timeout" }, { status: "cleanup_unknown", residue: ["made_up"] }),
    wire({ outcome: "timeout" }, VERIFIED, { extra: 1 }),
    line({ ...dmEncodeLauncherLaunched(sent, { outcome: "timeout" }, VERIFIED), requestId: EVENT_ID }),
    line({ ...dmEncodeLauncherLaunched(sent, { outcome: "timeout" }, VERIFIED), instance: ANTHROPIC }),
    line({ ...dmEncodeLauncherLaunched(sent, { outcome: "timeout" }, VERIFIED), v: 2 }),
    "not json",
  ];
  for (const bad of rejected) assert.equal(dmParseLauncherAnswer(bad, sent), null, bad.slice(0, 120));
});

test("a cleanup crosses the socket as kinds only; the paths stay with the launcher", () => {
  const cleanup = {
    status: "cleanup_unknown",
    residue: [
      { kind: "state_entry_present", path: "/home/amux-dm-openai/.codex/sessions/question-title.json" },
      { kind: "state_entry_present", path: "/home/amux-dm-openai/.codex/other" },
    ],
  };
  const encoded = line(dmEncodeLauncherLaunched(sent, { outcome: "timeout" }, cleanup));
  assert.doesNotMatch(encoded, /question-title|\.codex/);
  assert.deepEqual(dmParseLauncherAnswer(encoded, sent).cleanup, { status: "cleanup_unknown", residue: ["state_entry_present"] });
  const rejectedAnswer = dmParseLauncherAnswer(line(dmEncodeLauncherRejected("instance_mismatch", cleanup)), sent);
  assert.deepEqual(rejectedAnswer, {
    type: "rejected",
    error: "instance_mismatch",
    cleanup: { status: "cleanup_unknown", residue: ["state_entry_present"] },
  });
});

// ---------------------------------------------------------------------------
// The broker's answer
// ---------------------------------------------------------------------------

test("§10: a DM process counts as started only when the launcher says one ran", () => {
  const launched = (result) => dmTransmissionOf({ kind: "launched", result, cleanup: VERIFIED });
  assert.equal(launched({ outcome: "refused", refusals: ["cli_state_residue"] }), "not_started");
  assert.equal(launched({ outcome: "output", raw: "{}" }), "process_ended");
  assert.equal(launched({ outcome: "timeout" }), "process_ended");
  for (const reason of DM_LAUNCH_UNAVAILABLE_REASONS) {
    const expected = reason === "spawn_failed" ? "not_started" : reason === "launcher_fault" ? "unknown" : "process_ended";
    assert.equal(launched({ outcome: "unavailable", reason }), expected, reason);
  }
  assert.equal(dmTransmissionOf({ kind: "broker_refused", refusals: ["busy"] }), "not_started");
  assert.equal(dmTransmissionOf({ kind: "launcher_unreachable", reason: "ready_missing" }), "not_started");
  assert.equal(dmTransmissionOf({ kind: "launcher_rejected", error: "request_malformed", cleanup: VERIFIED }), "not_started");
  assert.equal(dmTransmissionOf({ kind: "launcher_lost", reason: "response_missing" }), "unknown");
  assert.equal(dmTransmissionOf({ kind: "broker_fault", contacted: false }), "not_started");
  assert.equal(dmTransmissionOf({ kind: "broker_fault", contacted: true }), "unknown");
});

const answerOf = (view, extra = {}) =>
  dmBrokerAnswer({
    requestId: REQUEST_ID,
    instance: OPENAI,
    requestKey: REQUEST_KEY,
    view,
    requestDirectory: VERIFIED,
    requestRoot: [],
    ...extra,
  });

test("§2-5, §9: the DM output goes to the bridge in the answer with its request-keyed result digest", () => {
  const raw = '{"kind":"select","optionId":"b","rationale":"r","irreversible":false}';
  const answer = answerOf({ kind: "launched", result: { outcome: "output", raw }, cleanup: VERIFIED });
  assert.deepEqual(answer, {
    v: 1,
    type: "result",
    requestId: REQUEST_ID,
    instance: OPENAI,
    transmission: "process_ended",
    result: { kind: "output", raw },
    resultDigest: dmResultDigest(REQUEST_KEY, { kind: "output", raw }),
    launch: { outcome: "output", reasons: [] },
    cleanup: VERIFIED,
  });
  const timeout = answerOf({ kind: "launched", result: { outcome: "timeout" }, cleanup: VERIFIED });
  assert.deepEqual(timeout.result, { kind: "timeout" });
  assert.equal(timeout.resultDigest, dmResultDigest(REQUEST_KEY, { kind: "timeout" }));
});

test("§9: every answer without an output is DM 불가, with the reasons as codes", () => {
  const views = [
    { kind: "broker_refused", refusals: ["transmit_intent_mismatch"] },
    { kind: "launcher_unreachable", reason: "connect_failed" },
    { kind: "launcher_rejected", error: "request_malformed", cleanup: VERIFIED },
    { kind: "launched", result: { outcome: "refused", refusals: ["executable_sha256_mismatch", "cli_state_residue"] }, cleanup: VERIFIED },
    { kind: "launched", result: { outcome: "unavailable", reason: "is_error" }, cleanup: VERIFIED },
    { kind: "launcher_lost", reason: "response_timeout" },
    { kind: "broker_fault", contacted: true },
  ];
  for (const view of views) {
    const answer = answerOf(view);
    assert.deepEqual(answer.result, { kind: "unavailable" }, view.kind);
    assert.equal(answer.resultDigest, dmResultDigest(REQUEST_KEY, { kind: "unavailable" }));
  }
  assert.deepEqual(answerOf(views[3]).launch, { outcome: "refused", reasons: ["executable_sha256_mismatch", "cli_state_residue"] });
  assert.deepEqual(answerOf(views[0]).launch, { outcome: "broker_refused", reasons: ["transmit_intent_mismatch"] });
  // Without a readable key there is no digest to give.
  assert.equal(answerOf(views[0], { requestKey: null }).resultDigest, null);
});

test("§5: anything left or unverifiable, on either side, is cleanup_unknown with its scope", () => {
  const lost = answerOf({ kind: "launcher_lost", reason: "response_missing" });
  assert.deepEqual(lost.cleanup, { status: "cleanup_unknown", residue: [{ scope: "vendor", kind: "launcher_report_missing" }] });
  const vendor = answerOf(
    { kind: "launched", result: { outcome: "timeout" }, cleanup: { status: "cleanup_unknown", residue: ["scratch_entry_present", "path_unsafe"] } },
    { requestDirectory: { status: "cleanup_unknown", residue: [{ kind: "request_path_present", path: "/var/lib/amux-dm/requests/x" }] } },
  );
  assert.deepEqual(vendor.cleanup, {
    status: "cleanup_unknown",
    residue: [
      { scope: "vendor", kind: "scratch_entry_present" },
      { scope: "vendor", kind: "path_unsafe" },
      { scope: "request_directory", kind: "request_path_present" },
    ],
  });
  const leftover = answerOf({ kind: "broker_refused", refusals: ["request_root_leftover"] }, { requestDirectory: null, requestRoot: ["request_root_leftover"] });
  assert.deepEqual(leftover.cleanup, { status: "cleanup_unknown", residue: [{ scope: "request_root", kind: "request_root_leftover" }] });
  assert.deepEqual(answerOf({ kind: "broker_refused", refusals: ["busy"] }, { requestDirectory: null }).cleanup, VERIFIED);
});

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

test("a line is read across chunks, and its newline ends it", async () => {
  const stream = new PassThrough();
  const pending = dmReadLine(stream, 64, 1000);
  stream.write('{"a":');
  stream.write('"b"}\n');
  assert.deepEqual(await pending, { ok: true, line: '{"a":"b"}' });
  assert.equal(await dmWriteLine(stream, { c: 1 }, 1000), true);
  assert.deepEqual(await dmReadLine(stream, 64, 1000), { ok: true, line: '{"c":1}' });
});

test("a line over the cap, after the newline, cut short, silent or not UTF-8 is not a line", async () => {
  const fed = async (chunks, maxBytes = 8, timeoutMs = 1000) => {
    const stream = new PassThrough();
    const pending = dmReadLine(stream, maxBytes, timeoutMs);
    for (const chunk of chunks) {
      if (chunk === null) stream.end();
      else stream.write(chunk);
    }
    return pending;
  };
  assert.deepEqual(await fed(["123456789\n"]), { ok: false, error: "too_large" });
  assert.deepEqual(await fed(["12345", "6789"]), { ok: false, error: "too_large" });
  assert.deepEqual(await fed(["1\n2"]), { ok: false, error: "trailing_bytes" });
  assert.deepEqual(await fed(["12", null]), { ok: false, error: "closed" });
  assert.deepEqual(await fed([], 8, 50), { ok: false, error: "timeout" });
  assert.deepEqual(await fed([Buffer.from([0xff, 0x0a])]), { ok: false, error: "not_utf8" });
  // The cap counts the line, not its newline.
  assert.deepEqual(await fed(["12345678\n"]), { ok: true, line: "12345678" });
});

// ---------------------------------------------------------------------------
// The parts protocol (docs/policy/amux-v22-result-transfer.md 10.2)
// ---------------------------------------------------------------------------

const SHA = "0123456789abcdef0123456789abcdef01234567";
const partsWorkspace = (parts) => ({ state: "develop", targetSha: SHA, parts });
const onePart = { name: "PATCH.diff", bytes: 150 * 1024 * 1024, sha256: "a".repeat(64) };

test("a launch names a workspace by description: no byte of evidence is in the line, and a file may be any size", () => {
  const parsed = dmParseLaunchRequest(line(launch({ workspace: partsWorkspace([onePart]) })));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.request.workspaceParts, partsWorkspace([onePart]));
  assert.equal(parsed.request.workspace, null, "the files are not known until they arrive");
  // The line is the payload and a few hundred bytes, whatever the evidence weighs.
  assert.ok(Buffer.byteLength(line(launch({ workspace: partsWorkspace([onePart]) }))) < 4096);
  // No description: the workspace is the commit alone, with nothing to wait for.
  assert.deepEqual(dmParseLaunchRequest(line(launch({ workspace: partsWorkspace([]) }))).request.workspaceParts, partsWorkspace([]));
  // Anything but the exact description is a workspace that does not match.
  for (const workspace of [
    partsWorkspace([{ ...onePart, name: "x.sh" }]),
    partsWorkspace([onePart, onePart]),
    partsWorkspace([{ ...onePart, bytes: 0 }]),
    partsWorkspace([{ ...onePart, sha256: "nope" }]),
    { ...partsWorkspace([onePart]), files: [] },
    { state: "none", targetSha: SHA, parts: [] },
  ]) {
    const refused = dmParseLaunchRequest(line(launch({ workspace })));
    assert.deepEqual([refused.ok, refused.refusal], [false, "workspace_mismatch"], JSON.stringify(workspace).slice(0, 80));
  }
});

test("a chunk line is exactly the chunk the broker expects: this request, this file, this index, that range's length", () => {
  const total = AMUX_V22_TRANSFER_CHUNK_BYTES + 10;
  const expected = (index) => ({ requestId: REQUEST_ID, name: "PATCH.diff", index, totalBytes: total });
  const first = Buffer.alloc(AMUX_V22_TRANSFER_CHUNK_BYTES, 7);
  const last = Buffer.alloc(10, 9);
  const parse = (value, index) => dmParsePartLine(line(value), expected(index));
  // The full chunk fits the line cap with its envelope; the last is the short remainder.
  assert.ok(Buffer.byteLength(line(dmEncodePartLine(REQUEST_ID, "PATCH.diff", 0, first))) < DM_PART_LINE_MAX_BYTES);
  assert.deepEqual(parse(dmEncodePartLine(REQUEST_ID, "PATCH.diff", 0, first), 0), { kind: "part", bytes: first });
  assert.deepEqual(parse(dmEncodePartLine(REQUEST_ID, "PATCH.diff", 1, last), 1), { kind: "part", bytes: last });
  assert.deepEqual(parse(dmEncodeAbortLine(REQUEST_ID), 0), { kind: "abort" });
  for (const [bad, index] of [
    [dmEncodePartLine(REQUEST_ID, "PATCH.diff", 1, first), 0],
    [dmEncodePartLine(REQUEST_ID, "FINDINGS.md", 0, first), 0],
    [dmEncodePartLine("0a1b2c3d-4e5f-4a6b-8c7d-000000000002", "PATCH.diff", 0, first), 0],
    [dmEncodePartLine(REQUEST_ID, "PATCH.diff", 0, first.subarray(1)), 0],
    [dmEncodePartLine(REQUEST_ID, "PATCH.diff", 1, first), 1],
    [{ ...dmEncodePartLine(REQUEST_ID, "PATCH.diff", 1, last), extra: 1 }, 1],
    [{ ...dmEncodePartLine(REQUEST_ID, "PATCH.diff", 1, last), bytesBase64: "AA=A" }, 1],
    [{ ...dmEncodeAbortLine(REQUEST_ID), extra: 1 }, 0],
    [dmEncodeSendParts(REQUEST_ID), 0],
  ]) {
    assert.equal(parse(bad, index), null, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(dmParsePartLine("not json", expected(0)), null);
  // What the broker answers the bridge.
  assert.deepEqual(dmEncodeSendParts(REQUEST_ID), { v: 1, type: "send_parts", requestId: REQUEST_ID });
  assert.deepEqual(dmEncodePartStored("PATCH.diff", 3), { v: 1, type: "part_stored", name: "PATCH.diff", index: 3 });
});
