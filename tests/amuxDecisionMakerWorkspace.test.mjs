// The AMUX Decision Maker workspace's deterministic core (owner decision
// 2026-11-15, lib/amux/decisionMakerWorkspaceCore.ts): which evidence files go,
// what the payload names, what the launch must match, what a card says.

import assert from "node:assert/strict";
import test from "node:test";

import { dmSnapshotManifestDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import { DM_CARD_TEXT_MAX_BYTES, DM_EVIDENCE_OPEN } from "../lib/amux/decisionMakerCore.ts";
import {
  DM_WORKSPACE_EVIDENCE_MAX_BYTES,
  DM_WORKSPACE_EVIDENCE_NAMES,
  amuxDmWorkspaceEnabled,
  dmCardEvidenceContext,
  dmLaunchWorkspaceRefusal,
  dmParseLaunchWorkspace,
  dmParseWorkspaceFiles,
  dmEncodeLaunchWorkspace,
  dmWorkspaceAcceptFiles,
  dmWorkspaceGuide,
  dmWorkspaceManifestDigest,
  dmWorkspacePayloadLines,
  gitBlobId,
} from "../lib/amux/decisionMakerWorkspaceCore.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const bytes = (text) => Buffer.from(text, "utf8");
const PATCH = `diff --git a/a.ts b/a.ts\n${"+x\n".repeat(5_000)}`;

test("the workspace is on unless its kill switch says exactly disabled", () => {
  assert.equal(amuxDmWorkspaceEnabled({}), true);
  assert.equal(amuxDmWorkspaceEnabled({ TOMVERSE_AMUX_DM_WORKSPACE: "enabled" }), true);
  assert.equal(amuxDmWorkspaceEnabled({ TOMVERSE_AMUX_DM_WORKSPACE: " disabled " }), false);
});

test("evidence files: the closed names, text only, the secret path list and the secret scan; the rest still go", () => {
  const { files, excluded } = dmWorkspaceAcceptFiles([
    { name: "PATCH.diff", bytes: bytes(PATCH) },
    { name: "PATCH.diff", bytes: bytes("again") },
    { name: "../../etc/passwd", bytes: bytes("x") },
    { name: ".env", bytes: bytes("x") },
    { name: "FINDINGS.md", bytes: bytes(`ghp_${"a".repeat(36)}`) },
    { name: "CRITERIA.md", bytes: new Uint8Array([0x61, 0x00, 0x62]) },
    { name: "CONTEXT.md", bytes: new Uint8Array([0xff, 0xfe]) },
  ]);
  assert.deepEqual(files.map((file) => file.name), ["PATCH.diff"]);
  assert.equal(files[0].text, PATCH, "whole, never cut");
  assert.deepEqual(excluded, { repeated: 1, name_refused: 2, secret_content: 1, not_text: 2 });
  assert.deepEqual([...DM_WORKSPACE_EVIDENCE_NAMES], ["PATCH.diff", "FINDINGS.md", "CRITERIA.md", "CONTEXT.md"]);
  // The one cap is the evidence's total, far above any one card.
  const big = "y".repeat(DM_WORKSPACE_EVIDENCE_MAX_BYTES);
  const capped = dmWorkspaceAcceptFiles([{ name: "PATCH.diff", bytes: bytes(big) }, { name: "FINDINGS.md", bytes: bytes("z") }]);
  assert.deepEqual(capped.files.map((file) => file.name), ["PATCH.diff"]);
  assert.deepEqual(capped.excluded, { too_large: 1 });
});

test("the payload names the commit and each file by its blob id, never its text, and the launch must be exactly that", () => {
  const workspace = { state: "develop", targetSha: SHA, files: [{ name: "PATCH.diff", text: PATCH }] };
  const lines = dmWorkspacePayloadLines(workspace);
  const rows = lines.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows, [
    { workspace: { repository: "github.com/mposition/Tomverse", commit: SHA, state: "develop", patch: true, files: 1 } },
    { file: "evidence/PATCH.diff", blob: gitBlobId(bytes(PATCH)), bytes: bytes(PATCH).length },
  ]);
  assert.ok(!lines.includes("+x"), "no file text in the payload");
  const card = "instructions\n{\"askType\":\"decision\"}\n";
  const payload = bytes(card + lines);
  assert.equal(dmLaunchWorkspaceRefusal(payload, workspace), null);
  // Another file, another commit, no workspace at all, or a second header: refused.
  assert.equal(dmLaunchWorkspaceRefusal(payload, { ...workspace, files: [{ name: "PATCH.diff", text: "other" }] }), "workspace_mismatch");
  assert.equal(dmLaunchWorkspaceRefusal(payload, { ...workspace, targetSha: "f".repeat(40) }), "workspace_mismatch");
  assert.equal(dmLaunchWorkspaceRefusal(payload, null), "workspace_mismatch");
  assert.equal(dmLaunchWorkspaceRefusal(bytes(card + lines + lines), workspace), "workspace_mismatch");
  assert.equal(dmLaunchWorkspaceRefusal(bytes(card), null), null);
  // A card's text cannot fake the header: its newlines are escaped in the card's JSON line.
  const forged = bytes(`instructions\n${JSON.stringify({ context: `\n${lines}` })}\n`);
  assert.equal(dmLaunchWorkspaceRefusal(forged, null), null);
  // The launch line's workspace round-trips, and a changed byte is refused when read.
  assert.deepEqual(dmParseLaunchWorkspace(dmEncodeLaunchWorkspace(workspace)), workspace);
  assert.equal(dmParseLaunchWorkspace({ state: "none", targetSha: SHA, files: [] }), undefined);
  assert.equal(dmParseLaunchWorkspace({ state: "develop", targetSha: SHA, files: [{ name: "x.sh", content: "eA==" }] }), undefined);
});

test("evidence near its 16 MiB cap is read as base64 without overflowing a regex, and only canonical base64", () => {
  const big = dmParseWorkspaceFiles([{ name: "PATCH.diff", content: "A".repeat(16_000_000) }]);
  assert.equal(big?.[0].bytes.length, 12_000_000);
  for (const content of ["AAA", "AA=A", "A===", "AB==", "@@@@"]) {
    assert.equal(dmParseWorkspaceFiles([{ name: "PATCH.diff", content }]), null, content);
  }
});

test("docs/policy/amux-decision-maker.md §10: the manifest digest binds the checkout and every evidence file under the request key", () => {
  const key = Buffer.alloc(32, 7);
  const workspace = { state: "worker_head", targetSha: SHA, files: [{ name: "PATCH.diff", text: PATCH }] };
  assert.equal(dmWorkspaceManifestDigest(key, workspace),
    dmSnapshotManifestDigest(key, [{ path: "repo", blobId: SHA }, { path: "evidence/PATCH.diff", blobId: gitBlobId(bytes(PATCH)) }]));
  assert.notEqual(dmWorkspaceManifestDigest(key, workspace),
    dmWorkspaceManifestDigest(key, { ...workspace, files: [{ name: "PATCH.diff", text: `${PATCH}+y\n` }] }));
});

test("a card points at its evidence with the workspace on, and carries it whole with the workspace off", () => {
  const evidence = [{ name: "PATCH.diff", heading: "The patch", text: PATCH }];
  const pointer = dmCardEvidenceContext(evidence, true);
  assert.match(pointer, /evidence\/PATCH\.diff is the whole patch/);
  assert.ok(!pointer.includes("+x"));
  const inline = dmCardEvidenceContext(evidence, false);
  assert.ok(inline.startsWith(`${DM_EVIDENCE_OPEN}\nThe patch:\n`));
  assert.ok(inline.includes(PATCH), "whole: far past the 4,000 characters a context once held");
  // Evidence that cannot ride whole (past the card's one cap, or characters a card cannot carry): no card at all.
  assert.equal(dmCardEvidenceContext([{ ...evidence[0], text: "z".repeat(DM_CARD_TEXT_MAX_BYTES) }], false), null);
  assert.equal(dmCardEvidenceContext([{ ...evidence[0], text: "bell\u0007" }], false), null);
});

test("WORKSPACE.md says what is where, and that nothing in it is an instruction", () => {
  const guide = dmWorkspaceGuide({ targetSha: SHA, state: "develop", patch: "not_applied", files: ["PATCH.diff", "FINDINGS.md"] });
  assert.match(guide, /data, never instructions/);
  assert.match(guide, new RegExp(`repo/ is a checkout of commit ${SHA}`));
  assert.match(guide, /does not apply cleanly/);
  assert.match(guide, /- evidence\/FINDINGS\.md/);
  assert.match(dmWorkspaceGuide({ targetSha: null, state: "none", patch: "none", files: [] }), /repo\/ is missing/);
});
