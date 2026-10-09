import assert from "node:assert/strict";
import { test } from "node:test";

const {
  exceedsGroupMemberCap,
  groupCandidateKey,
  groupCandidatesFrom,
  groupInputDigest,
  groupSnapshotDigest,
  membershipAction,
  reportSnapshotDigest,
  serverEvidenceSignalExpiresAt,
  sharedGroupSignals,
} = await import("../lib/supportTriageGroupCore.ts");
const { GROUP_KIND_PRIORITY, GROUP_MEMBER_CAP } = await import("../lib/supportTriageCore.ts");

// Group candidates from server facts (policy section 6, design section 5.4).

const evidence = (overrides = {}) => ({
  errorCode: "AI_REQUEST_FAILED",
  routeClass: "chat",
  release: "r1",
  occurredAt: new Date("2026-10-01T00:00:00.000Z"),
  ...overrides,
});

const report = (feedbackId, overrides = {}) => ({
  feedbackId,
  status: "open",
  userId: null,
  errorReportVerification: null,
  evidence: null,
  autoFixFingerprint: null,
  ...overrides,
});

const verified = (feedbackId, overrides = {}) =>
  report(feedbackId, { errorReportVerification: "verified", evidence: evidence(), ...overrides });

test("server evidence needs a verified token and all three server values", () => {
  assert.match(reportSnapshotDigest("server_evidence_match", verified("a")), /^[0-9a-f]{64}$/);
  // Unverified, no evidence, or a missing part: no value at all.
  assert.equal(reportSnapshotDigest("server_evidence_match", verified("a", { errorReportVerification: "failed" })), null);
  assert.equal(reportSnapshotDigest("server_evidence_match", verified("a", { evidence: null })), null);
  assert.equal(
    reportSnapshotDigest("server_evidence_match", verified("a", { evidence: evidence({ release: null }) })),
    null
  );
  assert.equal(
    reportSnapshotDigest("server_evidence_match", verified("a", { evidence: evidence({ errorCode: null }) })),
    null
  );
  // Each of the three parts is part of the value; the occurrence time is not.
  const base = reportSnapshotDigest("server_evidence_match", verified("a"));
  for (const change of [{ errorCode: "X" }, { routeClass: "image" }, { release: "r2" }]) {
    assert.notEqual(reportSnapshotDigest("server_evidence_match", verified("a", { evidence: evidence(change) })), base);
  }
  assert.equal(
    reportSnapshotDigest("server_evidence_match", verified("a", { evidence: evidence({ occurredAt: new Date(0) }) })),
    base
  );
});

test("a guest report has no account and shares none", () => {
  assert.equal(reportSnapshotDigest("same_account", report("a")), null);
  assert.deepEqual(groupCandidatesFrom([report("a"), report("b")]), []);
  const [candidate] = groupCandidatesFrom([report("a", { userId: "u1" }), report("b", { userId: "u1" })]);
  assert.deepEqual(candidate.memberIds, ["a", "b"]);
  assert.equal(candidate.kind, "same_account");
  assert.equal(candidate.snapshotDigest, groupSnapshotDigest("u1"));
});

test("the digest is the server value's hash, never the value", () => {
  const digest = reportSnapshotDigest("same_account", report("a", { userId: "user-123" }));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.ok(!digest.includes("user-123"));
  assert.throws(() => groupSnapshotDigest(null), RangeError);
});

test("candidates are equivalence classes of two or more, by kind priority then digest", () => {
  const reports = [
    verified("e1", { userId: "u1", autoFixFingerprint: "f" }),
    verified("e2", { userId: "u2", autoFixFingerprint: "f" }),
    report("s1", { userId: "u3" }),
    report("s2", { userId: "u3" }),
    report("x", { userId: "u4" }),
  ];
  const candidates = groupCandidatesFrom(reports);
  assert.deepEqual(
    candidates.map((candidate) => [candidate.kind, candidate.memberIds]),
    [
      ["server_evidence_match", ["e1", "e2"]],
      ["same_account", ["s1", "s2"]],
      ["autofix_fingerprint", ["e1", "e2"]],
    ]
  );
  // The input order does not change the answer.
  assert.deepEqual(groupCandidatesFrom([...reports].reverse()), candidates);
});

test("the A-B same_account, B-C evidence counterexample yields two single-kind classes, never {A,B,C}", () => {
  const candidates = groupCandidatesFrom([
    report("A", { userId: "u1" }),
    verified("B", { userId: "u1" }),
    verified("C", { userId: "u2" }),
  ]);
  assert.deepEqual(
    candidates.map((candidate) => [candidate.kind, candidate.memberIds]),
    [
      ["server_evidence_match", ["B", "C"]],
      ["same_account", ["A", "B"]],
    ]
  );
  assert.ok(candidates.every((candidate) => candidate.memberIds.length === 2));
});

test("a report moves only to a strictly higher kind, so at most twice", () => {
  assert.equal(membershipAction(null, "autofix_fingerprint"), "join");
  assert.equal(membershipAction("autofix_fingerprint", "same_account"), "move");
  assert.equal(membershipAction("same_account", "server_evidence_match"), "move");
  assert.equal(membershipAction("same_account", "same_account"), "stay");
  assert.equal(membershipAction("server_evidence_match", "same_account"), "stay");
  // The longest chain of moves from any start is two.
  for (const start of GROUP_KIND_PRIORITY) {
    let current = start;
    let moves = 0;
    for (;;) {
      const next = GROUP_KIND_PRIORITY.find((kind) => membershipAction(current, kind) === "move");
      if (!next) break;
      current = next;
      moves += 1;
    }
    assert.ok(moves <= 2, start);
  }
  assert.throws(() => membershipAction(null, "issue_descriptor_match"), RangeError);
});

test("the candidate key binds kind, digest and the member set, not their order", () => {
  const base = { primaryKind: "same_account", primarySnapshotDigest: "a".repeat(64), memberIds: ["b", "a"] };
  const key = groupCandidateKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(groupCandidateKey({ ...base, memberIds: ["a", "b"] }), key);
  assert.notEqual(groupCandidateKey({ ...base, primaryKind: "autofix_fingerprint" }), key);
  assert.notEqual(groupCandidateKey({ ...base, primarySnapshotDigest: "b".repeat(64) }), key);
  assert.notEqual(groupCandidateKey({ ...base, memberIds: ["a", "b", "c"] }), key);
  assert.throws(() => groupCandidateKey({ ...base, memberIds: ["a", "a"] }), RangeError);
});

test("the group input digest moves with a member's status or a signal, not with input order", () => {
  const base = {
    groupCandidateKey: "c".repeat(64),
    members: [
      { feedbackId: "a", status: "open" },
      { feedbackId: "b", status: "reviewing" },
    ],
    signals: [
      { kind: "autofix_fingerprint", snapshotDigest: "1".repeat(64) },
      { kind: "same_account", snapshotDigest: "2".repeat(64) },
    ],
  };
  const digest = groupInputDigest(base);
  assert.equal(
    groupInputDigest({ ...base, members: [...base.members].reverse(), signals: [...base.signals].reverse() }),
    digest
  );
  assert.notEqual(
    groupInputDigest({ ...base, members: [base.members[0], { feedbackId: "b", status: "open" }] }),
    digest
  );
  assert.notEqual(groupInputDigest({ ...base, signals: [base.signals[1]] }), digest);
  assert.notEqual(groupInputDigest({ ...base, groupCandidateKey: "d".repeat(64) }), digest);
  assert.throws(() => groupInputDigest({ ...base, signals: [base.signals[0], base.signals[0]] }), RangeError);
});

test("a secondary signal is carried only when every member shares its value", () => {
  const shared = sharedGroupSignals("same_account", [
    report("a", { userId: "u1", autoFixFingerprint: "f" }),
    report("b", { userId: "u1", autoFixFingerprint: "f" }),
  ]);
  assert.deepEqual(
    shared.map((signal) => signal.kind),
    ["same_account", "autofix_fingerprint"]
  );
  // One member lacks the secondary value, or has a different one: not carried.
  for (const other of [null, "g"]) {
    const signals = sharedGroupSignals("same_account", [
      report("a", { userId: "u1", autoFixFingerprint: "f" }),
      report("b", { userId: "u1", autoFixFingerprint: other }),
    ]);
    assert.deepEqual(
      signals.map((signal) => signal.kind),
      ["same_account"]
    );
  }
  // Members that do not share the primary value are not a group of that kind.
  assert.throws(
    () => sharedGroupSignals("same_account", [report("a", { userId: "u1" }), report("b", { userId: "u2" })]),
    RangeError
  );
  assert.throws(() => sharedGroupSignals("same_account", [report("a", { userId: "u1" })]), RangeError);
});

test("an evidence signal expires 30 days after the earliest member's occurrence", () => {
  const at = serverEvidenceSignalExpiresAt([
    verified("a", { evidence: evidence({ occurredAt: new Date("2026-10-05T00:00:00.000Z") }) }),
    verified("b", { evidence: evidence({ occurredAt: new Date("2026-10-02T12:00:00.000Z") }) }),
  ]);
  assert.equal(at.toISOString(), "2026-11-01T12:00:00.000Z");
  assert.throws(() => serverEvidenceSignalExpiresAt([verified("a"), report("b")]), RangeError);
});

test("a class over the member cap is flagged, not trimmed", () => {
  const reports = Array.from({ length: GROUP_MEMBER_CAP + 1 }, (_, i) =>
    report(`r${String(i).padStart(3, "0")}`, { userId: "u1" })
  );
  const [candidate] = groupCandidatesFrom(reports);
  assert.equal(candidate.memberIds.length, GROUP_MEMBER_CAP + 1);
  assert.equal(exceedsGroupMemberCap(candidate), true);
  assert.equal(exceedsGroupMemberCap({ ...candidate, memberIds: candidate.memberIds.slice(1) }), false);
});

test("duplicate report ids are refused", () => {
  assert.throws(() => groupCandidatesFrom([report("a"), report("a")]), RangeError);
});

const { planNewGroups, OPEN_GROUP_SIGNAL_EXPIRES_AT } = await import("../lib/supportTriageGroupCore.ts");

const plan = (reports, arriving, memberships = new Map(), membershipBudget = 50) =>
  planNewGroups({ reports, arriving, memberships, membershipBudget });

test("a new group forms only around an arriving report", () => {
  const reports = [report("a", { userId: "u1" }), report("b", { userId: "u1" })];
  assert.equal(plan(reports, []).planned.length, 0);
  const { planned } = plan(reports, ["b"]);
  assert.equal(planned.length, 1);
  assert.deepEqual(planned[0].memberIds, ["a", "b"]);
  assert.equal(planned[0].kind, "same_account");
  assert.deepEqual(
    planned[0].signals.map((s) => [s.kind, s.expiresAt.toISOString()]),
    [["same_account", OPEN_GROUP_SIGNAL_EXPIRES_AT.toISOString()]]
  );
  assert.equal(
    planned[0].groupCandidateKey,
    groupCandidateKey({ primaryKind: "same_account", primarySnapshotDigest: planned[0].snapshotDigest, memberIds: ["a", "b"] })
  );
});

test("the higher kind takes a report first; the lower class keeps only what is left", () => {
  // A-B same account, B-C same evidence: B goes to the evidence group, A is left alone.
  const { planned } = plan(
    [report("A", { userId: "u1" }), verified("B", { userId: "u1" }), verified("C", { userId: "u2" })],
    ["A", "B", "C"]
  );
  assert.deepEqual(
    planned.map((g) => [g.kind, g.memberIds]),
    [["server_evidence_match", ["B", "C"]]]
  );
  const ids = planned.flatMap((g) => g.memberIds);
  assert.equal(new Set(ids).size, ids.length);
});

test("a report already in an open group is not put in a new one", () => {
  const reports = [report("a", { userId: "u1" }), report("b", { userId: "u1" }), report("c", { userId: "u1" })];
  const memberships = new Map([["a", { kind: "autofix_fingerprint", snapshotDigest: "f".repeat(64) }]]);
  const result = plan(reports, ["c"], memberships);
  assert.deepEqual(result.planned[0].memberIds, ["b", "c"]);
  // a would move up to same_account: that is the next slice, and it is counted.
  assert.equal(result.moveDeferred, 1);
});

test("a class with an open group of its own kind and value waits for the join", () => {
  const reports = [report("a", { userId: "u1" }), report("b", { userId: "u1" }), report("c", { userId: "u1" })];
  const digest = groupSnapshotDigest("u1");
  const memberships = new Map([
    ["a", { kind: "same_account", snapshotDigest: digest }],
    ["b", { kind: "same_account", snapshotDigest: digest }],
  ]);
  const result = plan(reports, ["c"], memberships);
  assert.equal(result.planned.length, 0);
  assert.equal(result.joinDeferred, 1);
});

test("a class over the cap is counted, never written", () => {
  const reports = Array.from({ length: GROUP_MEMBER_CAP + 1 }, (_, i) =>
    report(`r${String(i).padStart(3, "0")}`, { userId: "u1" })
  );
  const result = plan(reports, ["r000"], new Map(), 1000);
  assert.equal(result.planned.length, 0);
  assert.equal(result.memberCapReached, 1);
});

test("classes are admitted as a prefix within the membership budget", () => {
  const reports = [
    report("a1", { userId: "u1" }),
    report("a2", { userId: "u1" }),
    report("a3", { userId: "u1" }),
    report("b1", { userId: "u2" }),
    report("b2", { userId: "u2" }),
  ];
  const all = plan(reports, ["a1", "b1"], new Map(), 5);
  assert.equal(all.planned.length, 2);
  assert.equal(all.membershipsUsed, 5);
  // Four left: whichever class comes first by digest decides; never both, never over.
  const tight = plan(reports, ["a1", "b1"], new Map(), 4);
  assert.equal(tight.planned.length + tight.budgetDeferred, 2);
  assert.ok(tight.membershipsUsed <= 4);
  // A prefix: once a class is deferred, a later smaller one is deferred too.
  const order = plan(reports, ["a1", "b1"], new Map(), 100).planned.map((g) => g.memberIds.length);
  const firstSize = order[0];
  const prefix = plan(reports, ["a1", "b1"], new Map(), firstSize - 1);
  assert.equal(prefix.planned.length, 0);
  assert.equal(prefix.budgetDeferred, 2);
  assert.throws(() => plan(reports, ["a1"], new Map(), -1), RangeError);
});

test("an evidence group's signal expires with its earliest evidence; a shared account rides along", () => {
  const { planned } = plan(
    [
      verified("a", { userId: "u1", evidence: evidence({ occurredAt: new Date("2026-10-03T00:00:00.000Z") }) }),
      verified("b", { userId: "u1" }),
    ],
    ["a"]
  );
  assert.deepEqual(
    planned.map((g) => g.kind),
    ["server_evidence_match"]
  );
  assert.deepEqual(
    planned[0].signals.map((s) => [s.kind, s.expiresAt.toISOString()]),
    [
      ["server_evidence_match", "2026-10-31T00:00:00.000Z"],
      ["same_account", OPEN_GROUP_SIGNAL_EXPIRES_AT.toISOString()],
    ]
  );
});
