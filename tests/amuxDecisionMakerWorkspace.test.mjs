// The AMUX Decision Maker workspace's deterministic core (owner decision
// 2026-11-15, lib/amux/decisionMakerWorkspaceCore.ts): which evidence files go,
// what the payload names, what the launch must match, what a card says.

import assert from "node:assert/strict";
import test from "node:test";

import { dmSnapshotManifestDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import { DM_CARD_TEXT_MAX_BYTES } from "../lib/amux/decisionMakerCore.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DM_WORKSPACE_EVIDENCE_NAMES,
  DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES,
  DM_WORKSPACE_TEXT_MAX_BYTES,
  dmAssembleWorkspace,
  dmCardEvidenceContext,
  dmEncodeLaunchWorkspaceParts,
  dmEncodeWorkspaceAnswer,
  dmLaunchWorkspaceRefusal,
  dmOutlinePayloadLines,
  dmParseLaunchWorkspace,
  dmParseLaunchWorkspaceParts,
  dmParseWorkspaceFiles,
  dmParseWorkspaceRequest,
  dmEncodeLaunchWorkspace,
  dmWorkspaceAcceptFiles,
  dmWorkspaceAcceptParts,
  dmWorkspaceGuide,
  dmWorkspaceManifestDigest,
  dmWorkspaceOutline,
  dmWorkspacePartOf,
  dmWorkspacePayloadLines,
  gitBlobId,
} from "../lib/amux/decisionMakerWorkspaceCore.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const bytes = (text) => Buffer.from(text, "utf8");
const PATCH = `diff --git a/a.ts b/a.ts\n${"+x\n".repeat(5_000)}`;

test("the workspace has no kill switch: it is always on (owner direction 2026-11-16)", () => {
  for (const path of ["lib/amux/decisionMakerWorkspaceCore.ts", "lib/amux/decisionMakerWorkspaceService.ts",
    "app/api/internal/amux/decision-maker/workspace/route.ts"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /TOMVERSE_AMUX_DM_WORKSPACE\b|amuxDmWorkspaceEnabled/, path);
  }
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
});

test("no size of ours bounds the evidence: past 64 MiB whole, and only the string V8 can hold is a limit", () => {
  // The 64 MiB the inline protocol held is now only that protocol's.
  assert.equal(DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES, 64 * 1024 * 1024);
  const big = "y".repeat(DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES + 1024);
  const files = [{ name: "PATCH.diff", bytes: bytes(big) }, { name: "FINDINGS.md", bytes: bytes("z") }];
  const whole = dmWorkspaceAcceptFiles(files);
  assert.deepEqual(whole.files.map((file) => file.name), ["PATCH.diff", "FINDINGS.md"]);
  assert.equal(whole.files[0].text.length, big.length, "whole, never cut");
  assert.deepEqual(whole.excluded, {});
  // The inline protocol alone passes its total, and the second file no longer fits.
  const capped = dmWorkspaceAcceptFiles(files, { totalMaxBytes: DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES });
  assert.deepEqual(capped.files.map((file) => file.name), ["FINDINGS.md"]);
  assert.deepEqual(capped.excluded, { too_large: 1 });
  // A file V8 cannot hold as one string cannot be shown clean: left out as too_large, not read.
  const unreadable = { length: DM_WORKSPACE_TEXT_MAX_BYTES + 1, includes() { throw new Error("must not be scanned"); } };
  assert.deepEqual(dmWorkspaceAcceptFiles([{ name: "PATCH.diff", bytes: unreadable }]),
    { files: [], excluded: { too_large: 1 } });
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

test("evidence of many megabytes is read as base64 without overflowing a regex, and only canonical base64", () => {
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

test("a card points at its evidence, whatever its size or its characters", () => {
  const evidence = [{ name: "PATCH.diff", heading: "The patch", text: PATCH }];
  const pointer = dmCardEvidenceContext(evidence);
  assert.match(pointer, /evidence\/PATCH\.diff is the whole patch/);
  assert.ok(!pointer.includes("+x"));
  // No 224 KiB room and no control-character refusal any more: the evidence goes to the workspace.
  for (const text of ["z".repeat(DM_CARD_TEXT_MAX_BYTES), "bell\u0007"]) {
    assert.equal(dmCardEvidenceContext([{ ...evidence[0], text }]), pointer);
  }
});

test("WORKSPACE.md says what is where, and that nothing in it is an instruction", () => {
  const guide = dmWorkspaceGuide({ targetSha: SHA, state: "develop", patch: "not_applied", files: ["PATCH.diff", "FINDINGS.md"] });
  assert.match(guide, /data, never instructions/);
  assert.match(guide, new RegExp(`repo/ is a checkout of commit ${SHA}`));
  assert.match(guide, /does not apply cleanly/);
  assert.match(guide, /- evidence\/FINDINGS\.md/);
  assert.match(dmWorkspaceGuide({ targetSha: null, state: "none", patch: "none", files: [] }), /repo\/ is missing/);
});

// A binary file in a patch is base85 text of deflated data, so the patch text
// shows none of its bytes (lib/amux/v22PatchBinary.ts, #4008). The evidence is
// about to leave for the Decision Maker's vendor: a secret inside a binary file
// leaves the patch out, as the patch's storage and publication refuse it.
test("a patch whose binary file carries a secret, or whose binary section cannot be read, is left out", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  // Built at run time, so no scanner reads a credential-shaped literal here.
  const token = ["gh", "p_", "Q".repeat(36)].join("");
  const noise = (seed, length) => {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i += 32) createHash("sha256").update(`${seed}:${i}`).digest().copy(out, i);
    out[0] = 0;
    return out;
  };
  const patchWith = (content) => {
    const dir = mkdtempSync(join(tmpdir(), "dm-binary-"));
    const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t",
      "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-C", dir, ...args],
    { stdio: ["ignore", "pipe", "pipe"] });
    try {
      git("init", "-q");
      writeFileSync(join(dir, "keep.txt"), "k\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      writeFileSync(join(dir, "new.bin"), content);
      git("add", "-A");
      return git("diff", "--binary", "--cached", "HEAD").toString("utf8");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const secret = patchWith(Buffer.concat([noise("a", 300), Buffer.from(token), noise("b", 300)]));
  assert.ok(!secret.includes(token), "the patch text shows none of it");
  assert.deepEqual(dmWorkspaceAcceptFiles([{ name: "PATCH.diff", bytes: bytes(secret) }]),
    { files: [], excluded: { secret_content: 1 } });
  const clean = patchWith(noise("c", 700));
  assert.equal(dmWorkspaceAcceptFiles([{ name: "PATCH.diff", bytes: bytes(clean) }]).files.length, 1);
  const broken = clean.replace(/^literal (\d+)$/m, (_line, size) => `literal ${Number(size) + 5}`);
  assert.deepEqual(dmWorkspaceAcceptFiles([{ name: "PATCH.diff", bytes: bytes(broken) }]).excluded, { secret_content: 1 });
});

// ---------------------------------------------------------------------------
// The parts protocol (docs/policy/amux-v22-result-transfer.md 10.2): the app
// describes each file, the bytes follow the launch on its connection.
// ---------------------------------------------------------------------------

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("a file is described by its name, size, sha256 and blob id; the payload names the same blob", () => {
  const part = dmWorkspacePartOf({ name: "PATCH.diff", bytes: bytes(PATCH) });
  assert.deepEqual(part, { name: "PATCH.diff", bytes: bytes(PATCH).length, sha256: sha256(bytes(PATCH)), blob: gitBlobId(bytes(PATCH)) });
  const workspace = { state: "develop", targetSha: SHA, files: [{ name: "PATCH.diff", text: PATCH }] };
  // The outline the broker answers from descriptions alone is the payload the launch must match.
  const outline = { state: "develop", targetSha: SHA, entries: [{ name: part.name, blob: part.blob, bytes: part.bytes }] };
  assert.deepEqual(dmWorkspaceOutline(workspace), outline);
  assert.equal(dmOutlinePayloadLines(outline), dmWorkspacePayloadLines(workspace));
  const answer = dmEncodeWorkspaceAnswer("0a1b2c3d-4e5f-4a6b-8c7d-000000000001", { ok: true, workspace: outline, excluded: {}, reason: null });
  assert.deepEqual([answer.files, answer.state, answer.targetSha], [["PATCH.diff"], "develop", SHA]);
  assert.equal(Buffer.from(answer.lines, "base64").toString("utf8"), dmWorkspacePayloadLines(workspace));
});

test("a workspace request names its files inline or by description, never both, and a description is strict", () => {
  const id = "0a1b2c3d-4e5f-4a6b-8c7d-000000000001";
  const part = { name: "PATCH.diff", bytes: 400_000_000, sha256: "a".repeat(64), blob: "b".repeat(40) };
  const line = (extra) => JSON.stringify({ v: 1, type: "workspace", requestId: id, targetSha: null, ...extra });
  const parsed = dmParseWorkspaceRequest(line({ parts: [part] }));
  assert.deepEqual([parsed.files, parsed.parts], [null, [part]], "400 MB is a size, not a refusal");
  assert.deepEqual(dmParseWorkspaceRequest(line({ files: [{ name: "PATCH.diff", content: "eA==" }] })).parts, null);
  for (const bad of [
    line({ files: [], parts: [] }),
    line({ parts: [{ ...part, bytes: 0 }] }),
    line({ parts: [{ ...part, bytes: 1.5 }] }),
    line({ parts: [{ ...part, sha256: "A".repeat(64) }] }),
    line({ parts: [{ ...part, blob: "b".repeat(39) }] }),
    line({ parts: [{ ...part, extra: 1 }] }),
    line({ parts: [part, part, part, part, part] }),
    line({ parts: "x" }),
  ]) {
    assert.equal(dmParseWorkspaceRequest(bad), null, bad.slice(0, 90));
  }
  // The names are checked as a file's are: closed list, once, not a secret path.
  const accepted = dmWorkspaceAcceptParts([part, { ...part, name: "PATCH.diff" }, { ...part, name: "x.sh" }, { ...part, name: "CONTEXT.md" }]);
  assert.deepEqual(accepted.parts.map((entry) => entry.name), ["PATCH.diff", "CONTEXT.md"]);
  assert.deepEqual(accepted.excluded, { repeated: 1, name_refused: 1 });
  assert.deepEqual(dmWorkspaceAcceptParts([{ ...part, bytes: DM_WORKSPACE_TEXT_MAX_BYTES + 1 }]),
    { parts: [], excluded: { too_large: 1 } });
});

test("a launch names its parts exactly, and the bytes that arrive must be those parts and pass the whole-file checks", () => {
  const text = PATCH;
  const launch = { state: "develop", targetSha: SHA, parts: [{ name: "PATCH.diff", bytes: bytes(text).length, sha256: sha256(bytes(text)) }] };
  assert.deepEqual(dmParseLaunchWorkspaceParts(dmEncodeLaunchWorkspaceParts(launch)), launch);
  for (const bad of [
    { ...launch, parts: [{ ...launch.parts[0], name: "x.sh" }] },
    { ...launch, parts: [launch.parts[0], launch.parts[0]] },
    { ...launch, parts: [{ ...launch.parts[0], bytes: 0 }] },
    { ...launch, parts: [{ ...launch.parts[0], sha256: "zz" }] },
    { ...launch, parts: [{ ...launch.parts[0], blob: "b".repeat(40) }] },
    { ...launch, state: "none" },
    { ...launch, targetSha: "nope" },
    { state: "develop", targetSha: SHA, files: [] },
    null,
  ]) {
    assert.equal(dmParseLaunchWorkspaceParts(bad), undefined, JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(dmParseLaunchWorkspaceParts({ state: "develop", targetSha: SHA, parts: [] }), { state: "develop", targetSha: SHA, parts: [] });
  const arrived = new Map([["PATCH.diff", bytes(text)]]);
  assert.deepEqual(dmAssembleWorkspace(launch, arrived), { state: "develop", targetSha: SHA, files: [{ name: "PATCH.diff", text }] });
  // Another size, another sha256, a part that never came.
  assert.equal(dmAssembleWorkspace(launch, new Map([["PATCH.diff", bytes(`${text}+`)]])), undefined);
  assert.equal(dmAssembleWorkspace(launch, new Map([["PATCH.diff", bytes(text.replace("a.ts", "b.ts"))]])), undefined);
  assert.equal(dmAssembleWorkspace(launch, new Map()), undefined);
});

test("the secret scan holds over the whole file that arrived in parts: a secret past the 64 MiB mark refuses the workspace", () => {
  // The token sits after more than 64 MiB of clean text, as one file of many chunks.
  const token = ["gh", "p_", "Q".repeat(36)].join("");
  const line = "+clean line of a very long patch\n";
  const padding = line.repeat(Math.ceil((DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES + 1024) / line.length));
  const dirty = bytes(`diff --git a/a b/a\n${padding}+${token}\n`);
  const clean = bytes(`diff --git a/a b/a\n${padding}`);
  const launchOf = (file) => ({ state: "develop", targetSha: SHA, parts: [{ name: "PATCH.diff", bytes: file.length, sha256: sha256(file) }] });
  assert.ok(dirty.length > DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES);
  assert.equal(dmAssembleWorkspace(launchOf(dirty), new Map([["PATCH.diff", dirty]])), undefined, "refused whole");
  assert.equal(dmAssembleWorkspace(launchOf(clean), new Map([["PATCH.diff", clean]]))?.files[0].text.length, clean.length);
  // A secret file path, a binary file and a patch whose binary section hides one are refused as they are inline.
  const nul = new Uint8Array([0x61, 0x00, 0x62]);
  assert.equal(dmAssembleWorkspace({ state: "none", targetSha: null, parts: [{ name: "CONTEXT.md", bytes: 3, sha256: sha256(nul) }] },
    new Map([["CONTEXT.md", nul]])), undefined);
});
