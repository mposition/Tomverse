import assert from "node:assert/strict";
import test from "node:test";
import { artifactVersionsPath, mergeGeneratedArtifactVersions, parseGeneratedArtifactVersions } from "../lib/generatedArtifactVersions.ts";

const row = (id = "revision-2", parentArtifactId = "original-1") => ({
  id, ordinal: 0, filename: "same.xlsx", format: "xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  byteSize: 100, status: "ready", lineageId: "original-1", parentArtifactId, createdAt: "2026-11-15T00:00:00.000Z",
});

test("version responses expose real opaque relationships and no retained content or storage location", () => {
  const result = parseGeneratedArtifactVersions({ artifacts: [{ ...row(), objectKey: "private/key", canonicalSpec: { secret: "content" }, url: "https://private.invalid" }], nextCursor: null });
  assert.ok(result);
  assert.equal(result.artifacts[0].parentArtifactId, "original-1");
  assert.equal(result.artifacts[0].lineageId, "original-1");
  assert.doesNotMatch(JSON.stringify(result), /objectKey|canonicalSpec|secret|private/);
});

test("same-name branches and a deleted source retain their actual independent parent relationships", () => {
  const result = parseGeneratedArtifactVersions({ artifacts: [row("branch-3"), row("branch-2"), row("orphan-4", null)], nextCursor: "older-1" });
  assert.ok(result);
  assert.deepEqual(result.artifacts.map(item => [item.id, item.parentArtifactId]), [
    ["branch-3", "original-1"], ["branch-2", "original-1"], ["orphan-4", null],
  ]);
  assert.equal(result.artifacts[2].lineageId, "original-1");
  assert.equal(result.nextCursor, "older-1");
});

test("unbounded, mixed-lineage, duplicate and malformed version pages are refused as a whole", () => {
  for (const artifacts of [
    Array.from({ length: 51 }, (_, i) => row(`file-${i}`)),
    [row(), row("other-2", "other-1"), { ...row("other-3"), lineageId: "other-1" }],
    [row(), row()], [{ ...row(), createdAt: "invalid" }], [{ ...row(), status: "failed" }],
    [{ ...row(), parentArtifactId: "revision-2" }], [{ ...row(), parentArtifactId: "https://private.invalid" }],
  ]) assert.equal(parseGeneratedArtifactVersions({ artifacts, nextCursor: null }), null);
  assert.equal(parseGeneratedArtifactVersions({ artifacts: [row()], nextCursor: "https://private.invalid" }), null);
});

test("pagination merges by exact identity without inferring a chain from matching names", () => {
  const current = parseGeneratedArtifactVersions({ artifacts: [row("branch-3")], nextCursor: "older-1" }).artifacts;
  const incoming = parseGeneratedArtifactVersions({ artifacts: [row("branch-2"), row("branch-3", null)], nextCursor: null }).artifacts;
  const merged = mergeGeneratedArtifactVersions(current, incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].parentArtifactId, null);
  assert.equal(merged[1].parentArtifactId, "original-1");
  assert.equal(artifactVersionsPath("opaque-id", "older-1"), "/api/artifacts/opaque-id/versions?cursor=older-1");
});
