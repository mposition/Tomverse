import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AMUX_V19_SECCOMP_FILTER_SHA256, AMUX_V19_SECCOMP_REFUSED_SYSCALLS,
  amuxV19SeccompFilterBytes } from "../lib/amux/ideaTrackedCheckoutSeccomp.mjs";

// A minimal classic-BPF interpreter for the four opcodes the filter uses, so
// the program is checked by what it decides rather than by its bytes alone.
function decide(bytes, { arch, nr }) {
  let accumulator = 0;
  for (let pc = 0; pc < bytes.length / 8;) {
    const code = bytes.readUInt16LE(pc * 8);
    const jt = bytes.readUInt8(pc * 8 + 2);
    const jf = bytes.readUInt8(pc * 8 + 3);
    const k = bytes.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) { accumulator = k === 4 ? arch : k === 0 ? nr : NaN; pc += 1; continue; }
    if (code === 0x15) { pc += 1 + (accumulator === k ? jt : jf); continue; }
    if (code === 0x35) { pc += 1 + (accumulator >= k ? jt : jf); continue; }
    if (code === 0x06) return k;
    throw new Error(`unexpected opcode ${code}`);
  }
  throw new Error("program fell off the end");
}

const X86_64 = 0xc000003e;
const I386 = 0x40000003;
const ALLOW = 0x7fff0000;
const ENOSYS = 0x00050000 | 38;
const KILL = 0x80000000;

test("io_uring and handle opens are refused with ENOSYS; ordinary file syscalls pass", () => {
  const bytes = amuxV19SeccompFilterBytes();
  for (const nr of Object.values(AMUX_V19_SECCOMP_REFUSED_SYSCALLS))
    assert.equal(decide(bytes, { arch: X86_64, nr }), ENOSYS, String(nr));
  // read, openat, open, openat2, getdents64, close, execve, mmap
  for (const nr of [0, 257, 2, 437, 217, 3, 59, 9])
    assert.equal(decide(bytes, { arch: X86_64, nr }), ALLOW, String(nr));
});

test("another ABI cannot reach an unobserved open", () => {
  const bytes = amuxV19SeccompFilterBytes();
  // i386 open via int 0x80 and an x32 openat both kill the process.
  assert.equal(decide(bytes, { arch: I386, nr: 5 }), KILL);
  assert.equal(decide(bytes, { arch: X86_64, nr: 0x40000000 | 257 }), KILL);
  assert.equal(decide(bytes, { arch: X86_64, nr: 0xffffffff }), KILL);
});

test("the program is pinned, deterministic and what was measured on the runner", () => {
  const bytes = amuxV19SeccompFilterBytes();
  assert.equal(bytes.length, 12 * 8);
  assert.deepEqual(amuxV19SeccompFilterBytes(), bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), AMUX_V19_SECCOMP_FILTER_SHA256);
  // The 2026-10-19 runner experiment used the filter with this digest prefix.
  assert.match(AMUX_V19_SECCOMP_FILTER_SHA256, /^ba9bd304cec00931/);
});
