import { posix } from "node:path";

const CHECKOUT = /^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/;
// %file covers 32-bit compat variants and handle-based opens. The io_uring
// calls are traced as well, then rejected because their SQEs are not decoded.
export const AMUX_V19_OPEN_TRACE_SYSCALLS =
  "%file,io_uring_setup,io_uring_enter,io_uring_register";
const OPEN_CALL = /(?:^|\s)(?:open|open64|openat|openat64|openat2)\(/;
const UNOBSERVABLE_OPEN =
  /(?:^|\s)(?:open_by_handle_at|io_uring_setup|io_uring_enter|io_uring_register)\(/;
const OPENED_FD = /\)\s+=\s+[0-9]+<([^<>]*)>\s*$/;
const MAX_LINE = 65_536;

/** Observe the path of each successfully opened checkout file from a Linux
 * strace file-syscall stream. The caller must establish that strace followed
 * the whole isolated process tree and closed its trace stream; a partial trace
 * can never certify a read manifest. Raw trace lines are discarded at once. */
export function createAmuxTrackedCheckoutOpenTraceObserver({ directory,
  files }) {
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
  let finished = false;
  const requestedRelativeFromCheckout = (line) => {
    const marker = `<${directory}>`;
    const offset = line.indexOf(marker);
    if (offset < 0) return false;
    const requested = /^,\s+"([^"\\]*)"/.exec(
      line.slice(offset + marker.length));
    return !requested || !requested[1].startsWith("/");
  };
  const consume = (line) => {
    if (UNOBSERVABLE_OPEN.test(line)) { invalid = true; return; }
    if (!OPEN_CALL.test(line)) return;
    const opened = OPENED_FD.exec(line);
    if (!opened) {
      if (/\)\s+=\s+-1\b/.test(line)) return;
      // Without a decoded FD, a successful open cannot be ruled out as a
      // checkout read, even when the request path was relative elsewhere.
      invalid = true;
      return;
    }
    const path = opened[1];
    const call = line.slice(0, opened.index);
    if (path === directory && /\b(?:O_DIRECTORY|O_PATH)\b/.test(call)) return;
    if (!path.startsWith(`${directory}/`)) {
      if (line.includes(`${directory}/`) ||
          requestedRelativeFromCheckout(line)) invalid = true;
      return;
    }
    const relative = path.slice(directory.length + 1);
    if (allowedDirectories.has(relative) &&
        /\b(?:O_DIRECTORY|O_PATH)\b/.test(call))
      return;
    if (!allowed.has(relative)) { invalid = true; return; }
    // O_PATH is metadata-only. A successful writable open contradicts the
    // read-only checkout contract; an unknown flag shape cannot certify it.
    if (/\bO_PATH\b/.test(call)) return;
    if (!/\b(?:O_RDONLY|O_RDWR)\b/.test(call) ||
        /\bO_WRONLY\b/.test(call)) { invalid = true; return; }
    observed.add(relative);
  };
  return Object.freeze({
    observeChunk(chunk) {
      if (finished || invalid || !(chunk instanceof Uint8Array)) {
        invalid = true;
        return;
      }
      try {
        tail += decoder.decode(chunk, { stream: true });
        if (tail.length > MAX_LINE && !tail.includes("\n")) {
          invalid = true; tail = ""; return;
        }
        let end;
        while ((end = tail.indexOf("\n")) >= 0) {
          if (end > MAX_LINE) { invalid = true; tail = ""; return; }
          consume(tail.slice(0, end));
          tail = tail.slice(end + 1);
        }
        if (tail.length > MAX_LINE) { invalid = true; tail = ""; }
      } catch { invalid = true; tail = ""; }
    },
    finish({ traceComplete } = {}) {
      if (finished) return { kind: "unverified" };
      finished = true;
      if (!invalid) {
        try {
          tail += decoder.decode();
          if (tail.length > 0) consume(tail);
        } catch { invalid = true; }
      }
      tail = "";
      return invalid || traceComplete !== true ? { kind: "unverified" } :
        { kind: "complete", files: [...observed].sort() };
    },
  });
}
