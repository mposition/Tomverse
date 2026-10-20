import { posix } from "node:path";

const CHECKOUT = /^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/;
// %file covers 32-bit compat variants and handle-based opens. The io_uring
// calls are traced as well: their SQEs are not decoded, so only a call the
// kernel refused (the v19 seccomp filter answers ENOSYS) leaves the manifest
// complete; any other outcome makes it unverified.
export const AMUX_V19_OPEN_TRACE_SYSCALLS =
  "%file,io_uring_setup,io_uring_enter,io_uring_register";
const OPEN_CALL = /(?:^|\s)(?:open|open64|openat|openat64|openat2)\(/;
const UNOBSERVABLE_OPEN =
  /(?:^|\s)(open_by_handle_at|io_uring_setup|io_uring_enter|io_uring_register)\(/;
// -yy appends a device annotation to a device node: `= 17</dev/null<char 1:3>>`
// (measured on the v19 runner when Node opens /dev/null). The path is group 1;
// group 2 marks a device, which is never a checkout file.
const OPENED_FD = /\)\s+=\s+[0-9]+<([^<>]*)(<(?:char|block) [0-9]+:[0-9]+>)?>\s*$/;
// strace prints the result last: `) = -1 ERRNO` and, usually, `(description)`.
// Both checks are anchored at the end of the line, so a path or argument that
// itself contains `) = -1 ` cannot make a successful call look failed.
const FAILED_RESULT = /\)\s+=\s+-1\s+([A-Z][A-Z0-9]*)(?:\s+\([^()]*\))?\s*$/;
const REFUSED_ERRNO = new Set(["ENOSYS", "EPERM"]);
const MAX_LINE = 65_536;
// strace -f splits a call that another thread interrupts:
//   `12 openat(AT_FDCWD</c>, "f", O_RDONLY <unfinished ...>`
//   `12 <... openat resumed>) = 21</c/f>`
// (measured on the v19 runner: 34 of 40 concurrent Node reads were split).
// A thread has at most one call in flight, so the halves pair by PID.
const TRACKED_CALLS = new Set(["open", "open64", "openat", "openat64", "openat2",
  "open_by_handle_at", "io_uring_setup", "io_uring_enter", "io_uring_register"]);
const SPLIT_START = /^([0-9]+)\s+([a-z0-9_]+)\(/;
const UNFINISHED = /\s<unfinished \.\.\.>\s*$/;
const RESUMED = /^([0-9]+)\s+<\.\.\. ([a-z0-9_]+) resumed>(.*)$/;
// Local-only diagnostic detail (TOMVERSE_AMUX_V19_DIAGNOSTIC_DETAIL): at most
// MAX_DETAIL refused opens, each a fixed code, a checkout-relative path (or
// OUTSIDE_PATH for one that left the checkout) and its O_* flag tokens.
const MAX_DETAIL = 20;
const MAX_DETAIL_PATH = 200;
const MAX_DETAIL_FLAGS = 12;
const OUTSIDE_PATH = "<outside>";
const OPEN_FLAG = /\bO_[A-Z0-9_]{1,24}\b/g;
const detailPath = (path) => path.slice(0, MAX_DETAIL_PATH)
  .replace(/[^\x20-\x7e]/g, "?");

/** Observe the path of each successfully opened checkout file from a Linux
 * strace file-syscall stream. The caller must establish that strace followed
 * the whole isolated process tree and closed its trace stream; a partial trace
 * can never certify a read manifest. Raw trace lines are discarded at once. */
export function createAmuxTrackedCheckoutOpenTraceObserver({ directory,
  files, diagnostic = false, detail = false }) {
  if (typeof directory !== "string" || !CHECKOUT.test(directory) ||
      !Array.isArray(files) || files.some((file) =>
        typeof file !== "string" || !file || file.startsWith("/") ||
        file.includes("\\") || posix.normalize(file) !== file ||
        file.split("/").some((part) => part === "." || part === ".."))) {
    throw new TypeError("invalid tracked checkout open trace");
  }
  const allowed = new Set(files);
  if (allowed.size !== files.length)
    throw new TypeError("invalid tracked checkout open trace");
  const allowedDirectories = new Set([""]);
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++)
      allowedDirectories.add(parts.slice(0, index).join("/"));
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const observed = new Set();
  let tail = "";
  let invalid = false;
  let invalidReason = null;
  let finished = false;
  const fail = (reason) => {
    invalid = true;
    invalidReason ??= reason;
  };
  // Never changes the verdict: it only names what a refused open touched.
  const details = [];
  const detailKeys = new Set();
  const noteOpen = (code, path, call) => {
    if (detail !== true || details.length >= MAX_DETAIL) return;
    const flags = [...new Set(call.match(OPEN_FLAG) ?? [])]
      .slice(0, MAX_DETAIL_FLAGS);
    const key = `${code}\0${path}\0${flags.join(",")}`;
    if (detailKeys.has(key)) return;
    detailKeys.add(key);
    details.push(Object.freeze({ code, path, flags: Object.freeze(flags) }));
  };
  const requestedRelativeFromCheckout = (line) => {
    const marker = `<${directory}>`;
    const offset = line.indexOf(marker);
    if (offset < 0) return false;
    const requested = /^,\s+"([^"\\]*)"/.exec(
      line.slice(offset + marker.length));
    return !requested || !requested[1].startsWith("/");
  };
  const splitCalls = new Map();
  const consume = (line) => {
    const resumed = RESUMED.exec(line);
    if (resumed) {
      const [, pid, name, rest] = resumed;
      const start = splitCalls.get(pid);
      if (start === undefined) {
        // An untracked call (statx, readlink, ...) resuming is not a read.
        if (TRACKED_CALLS.has(name)) fail("unpaired_resume");
        return;
      }
      splitCalls.delete(pid);
      if (start.name !== name) { fail("unpaired_resume"); return; }
      consumeWhole(start.text + rest);
      return;
    }
    if (UNFINISHED.test(line)) {
      const call = SPLIT_START.exec(line);
      if (!call || !TRACKED_CALLS.has(call[2])) return;
      if (splitCalls.has(call[1])) { fail("unpaired_resume"); return; }
      splitCalls.set(call[1], { name: call[2], text: line.replace(UNFINISHED, "") });
      return;
    }
    consumeWhole(line);
  };
  const consumeWhole = (line) => {
    const unobservable = UNOBSERVABLE_OPEN.exec(line);
    if (unobservable) {
      // A refused setup/open cannot have supplied file contents. Any success
      // or ambiguous outcome could bypass the path-resolved open observer.
      const failed = FAILED_RESULT.exec(line);
      if (!failed || !REFUSED_ERRNO.has(failed[1]))
        fail(`unobservable_${unobservable[1]}`);
      return;
    }
    if (!OPEN_CALL.test(line)) return;
    const opened = OPENED_FD.exec(line);
    if (!opened) {
      if (FAILED_RESULT.test(line)) return;
      // Without a decoded FD, a successful open cannot be ruled out as a
      // checkout read, even when the request path was relative elsewhere.
      fail("undecoded_open");
      return;
    }
    const path = opened[1];
    const device = opened[2] !== undefined;
    const call = line.slice(0, opened.index);
    if (path === directory && /\b(?:O_DIRECTORY|O_PATH)\b/.test(call)) return;
    if (!path.startsWith(`${directory}/`)) {
      if (line.includes(`${directory}/`) ||
          requestedRelativeFromCheckout(line)) {
        fail("escaped_checkout");
        noteOpen("escaped_checkout", OUTSIDE_PATH, call);
      }
      return;
    }
    const relative = path.slice(directory.length + 1);
    if (device) {
      fail("device_open");
      noteOpen("device_open", detailPath(relative), call);
      return;
    }
    if (allowedDirectories.has(relative) &&
        /\b(?:O_DIRECTORY|O_PATH)\b/.test(call))
      return;
    if (!allowed.has(relative)) {
      fail("unlisted_open");
      noteOpen("unlisted_open", detailPath(relative), call);
      return;
    }
    // O_PATH is metadata-only. A successful writable open contradicts the
    // read-only checkout contract; an unknown flag shape cannot certify it.
    if (/\bO_PATH\b/.test(call)) return;
    if (!/\b(?:O_RDONLY|O_RDWR)\b/.test(call) ||
        /\bO_WRONLY\b/.test(call)) {
      fail("non_read_open");
      noteOpen("non_read_open", detailPath(relative), call);
      return;
    }
    observed.add(relative);
  };
  return Object.freeze({
    observeChunk(chunk) {
      // With detail on, lines after the first refusal are still read, only to
      // name more refused opens; the verdict is already unverified.
      if (finished || (invalid && detail !== true) ||
          !(chunk instanceof Uint8Array)) {
        fail("invalid_stream");
        return;
      }
      try {
        tail += decoder.decode(chunk, { stream: true });
        if (tail.length > MAX_LINE && !tail.includes("\n")) {
          fail("oversized_line"); tail = ""; return;
        }
        let end;
        while ((end = tail.indexOf("\n")) >= 0) {
          if (end > MAX_LINE) { fail("oversized_line"); tail = ""; return; }
          consume(tail.slice(0, end));
          tail = tail.slice(end + 1);
        }
        if (tail.length > MAX_LINE) { fail("oversized_line"); tail = ""; }
      } catch { fail("invalid_stream"); tail = ""; }
    },
    finish({ traceComplete } = {}) {
      if (finished) return { kind: "unverified",
        ...(diagnostic ? { reason: "duplicate_finish" } : {}) };
      finished = true;
      if (!invalid || detail === true) {
        try {
          tail += decoder.decode();
          if (tail.length > 0) consume(tail);
        } catch { fail("invalid_stream"); }
      }
      // A tracked call that never resumed may still have opened a file.
      if (splitCalls.size > 0) fail("unfinished_open");
      splitCalls.clear();
      tail = "";
      return invalid || traceComplete !== true ? { kind: "unverified",
        ...(diagnostic ? { reason: invalidReason ?? "trace_incomplete" } : {}),
        ...(details.length > 0 ? { detail: Object.freeze([...details]) } : {}) } :
        { kind: "complete", files: [...observed].sort() };
    },
  });
}
