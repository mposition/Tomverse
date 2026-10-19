import { createHash } from "node:crypto";

/** The classic-BPF seccomp program bwrap installs (`--seccomp 3`) before the
 * v19 analysis process tree starts. It exists so every file read stays on the
 * path-resolved open(2) family that the trace observer decodes:
 * - an audit arch other than x86_64 (i386 `int 0x80` opens) or an x32 syscall
 *   number kills the process;
 * - io_uring_setup/enter/register and open_by_handle_at return ENOSYS, so
 *   Node (libuv) and other runtimes fall back to ordinary opens and reads;
 * - every other syscall is allowed; the bwrap namespaces, read-only mounts
 *   and CLI tool restrictions remain the isolation boundary.
 * Measured on the v19 Ubuntu runner (2026-10-19, Node 22.22.1, Claude CLI
 * 2.1.288): without it Node's io_uring_setup succeeds; with it each call is
 * refused and the checkout file is opened through an observed openat. */
const AUDIT_ARCH_X86_64 = 0xc000003e;
const X32_SYSCALL_BIT = 0x40000000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const ENOSYS = 38;
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;

/** x86_64 syscall numbers refused with ENOSYS. */
export const AMUX_V19_SECCOMP_REFUSED_SYSCALLS = Object.freeze({
  io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427, open_by_handle_at: 304,
});

const refused = Object.values(AMUX_V19_SECCOMP_REFUSED_SYSCALLS);
const PROGRAM = Object.freeze([
  [BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH],
  [BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64],
  [BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS],
  [BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_NR],
  [BPF_JMP_JGE_K, refused.length + 2, 0, X32_SYSCALL_BIT],
  ...refused.map((nr, index) => [BPF_JMP_JEQ_K, refused.length - index, 0, nr]),
  [BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW],
  [BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | ENOSYS],
  [BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS],
]);

/** struct sock_filter[] in host (little-endian x86_64) byte order. */
export function amuxV19SeccompFilterBytes() {
  const bytes = Buffer.alloc(PROGRAM.length * 8);
  PROGRAM.forEach(([code, jt, jf, k], index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes.writeUInt8(jt, index * 8 + 2);
    bytes.writeUInt8(jf, index * 8 + 3);
    bytes.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return bytes;
}

/** Pinned by test; a change to the program is a change to the trace contract. */
export const AMUX_V19_SECCOMP_FILTER_SHA256 =
  createHash("sha256").update(amuxV19SeccompFilterBytes()).digest("hex");
