// The v22 result transfer's shared values (docs/policy/amux-v22-result-transfer.md).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AMUX_V22_EMPTY_SHA256,
  AMUX_V22_PROXY_BODY_MAX_BYTES,
  AMUX_V22_TRANSFER_BODY_MAX_BYTES,
  AMUX_V22_TRANSFER_CHUNK_BYTES,
  amuxV22SizeAllowanceMs,
  amuxV22TransferChunkCount,
  amuxV22TransferChunkRange,
  decodeAmuxV22ChangedPaths,
  encodeAmuxV22ChangedPaths,
} from "../lib/amux/v22TransferCore.ts";

test("a full chunk's request fits one request under the proxy's body bound", () => {
  const base64 = Math.ceil(AMUX_V22_TRANSFER_CHUNK_BYTES / 3) * 4;
  assert.ok(base64 + 64 * 1024 <= AMUX_V22_TRANSFER_BODY_MAX_BYTES);
  assert.ok(AMUX_V22_TRANSFER_BODY_MAX_BYTES < AMUX_V22_PROXY_BODY_MAX_BYTES);
  assert.equal(AMUX_V22_EMPTY_SHA256, createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
});

test("chunk ranges cover a part exactly once, the last one shorter", () => {
  const C = AMUX_V22_TRANSFER_CHUNK_BYTES;
  assert.equal(amuxV22TransferChunkCount(0), 0);
  assert.equal(amuxV22TransferChunkCount(1), 1);
  assert.equal(amuxV22TransferChunkCount(C), 1);
  assert.equal(amuxV22TransferChunkCount(C + 1), 2);
  assert.deepEqual(amuxV22TransferChunkRange(C + 1, 0), { start: 0, end: C });
  assert.deepEqual(amuxV22TransferChunkRange(C + 1, 1), { start: C, end: C + 1 });
  assert.throws(() => amuxV22TransferChunkRange(C + 1, 2), RangeError);
  assert.throws(() => amuxV22TransferChunkRange(0, 0), RangeError);
  assert.throws(() => amuxV22TransferChunkCount(-1), RangeError);
});

test("time grows one second per chunk's worth of bytes", () => {
  assert.equal(amuxV22SizeAllowanceMs(0), 0);
  assert.equal(amuxV22SizeAllowanceMs(1), 1000);
  assert.equal(amuxV22SizeAllowanceMs(AMUX_V22_TRANSFER_CHUNK_BYTES), 1000);
  assert.equal(amuxV22SizeAllowanceMs(AMUX_V22_TRANSFER_CHUNK_BYTES * 10 + 1), 11_000);
});

test("a changed-path list round-trips as NUL-terminated UTF-8 in its order", () => {
  const paths = ["lib/a.ts", "docs/한글.md", "z/b"];
  const bytes = encodeAmuxV22ChangedPaths(paths);
  assert.equal(bytes.toString("utf8"), "lib/a.ts\0docs/한글.md\0z/b\0");
  assert.deepEqual(decodeAmuxV22ChangedPaths(bytes, 3), paths);
  assert.deepEqual(decodeAmuxV22ChangedPaths(encodeAmuxV22ChangedPaths([]), 0), []);
  assert.equal(createHash("sha256").update(encodeAmuxV22ChangedPaths([])).digest("hex"), AMUX_V22_EMPTY_SHA256);
});

test("a malformed changed-path list is refused", () => {
  assert.throws(() => encodeAmuxV22ChangedPaths(["a", "a"]), TypeError);
  assert.throws(() => encodeAmuxV22ChangedPaths([""]), TypeError);
  assert.throws(() => encodeAmuxV22ChangedPaths(["a\0b"]), TypeError);
  assert.throws(() => decodeAmuxV22ChangedPaths(Buffer.from("a\0b"), 2), TypeError);
  assert.throws(() => decodeAmuxV22ChangedPaths(Buffer.from("a\0\0"), 2), TypeError);
  assert.throws(() => decodeAmuxV22ChangedPaths(Buffer.from("a\0a\0"), 2), TypeError);
  assert.throws(() => decodeAmuxV22ChangedPaths(Buffer.from("a\0"), 2), TypeError);
  assert.throws(() => decodeAmuxV22ChangedPaths(Buffer.from([0xff, 0]), 1), TypeError);
  assert.throws(() => decodeAmuxV22ChangedPaths(Buffer.alloc(0), 1), TypeError);
});
