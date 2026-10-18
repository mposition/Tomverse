import { posix } from "node:path";

const CHECKOUT = /^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/;
const OPEN_CALL = /(?:^|\s)(?:open|openat|openat2)\(/;
const OPENED_FD = /\)\s+=\s+[0-9]+<([^<>]*)>\s*$/;

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
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const observed = new Set();
  let tail = "";
  let invalid = false;
  let finished = false;
  const requestedRelativeFromCheckout = (line) => {
    const marker = `AT_FDCWD<${directory}>`;
    const offset = line.indexOf(marker);
    if (offset < 0) return false;
    const requested = /^,\s+"([^"\\]*)"/.exec(
      line.slice(offset + marker.length));
    return !requested || !requested[1].startsWith("/");
  };
  const consume = (line) => {
    if (!OPEN_CALL.test(line)) return;
    const opened = OPENED_FD.exec(line);
    if (!opened) {
      if (/\)\s+=\s+-1\b/.test(line)) return;
      if (line.includes(`${directory}/`) ||
          line.includes(`AT_FDCWD<${directory}>`)) invalid = true;
      return;
    }
    const path = opened[1];
    if (!path.startsWith(`${directory}/`)) {
      if (line.includes(`${directory}/`) ||
          requestedRelativeFromCheckout(line)) invalid = true;
      return;
    }
    const relative = path.slice(directory.length + 1);
    if (!allowed.has(relative)) { invalid = true; return; }
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
        let end;
        while ((end = tail.indexOf("\n")) >= 0) {
          consume(tail.slice(0, end));
          tail = tail.slice(end + 1);
        }
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
