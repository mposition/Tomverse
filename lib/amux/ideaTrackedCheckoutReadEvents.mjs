import { posix } from "node:path";

const CHECKOUT = /^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/;
const TOOL_ID = /^[A-Za-z0-9_-]{1,160}$/;
const PASSIVE_EVENTS = new Set(["system", "rate_limit_event", "auth_status"]);

/** Observe files touched by successful Read calls, including partial reads,
 * without retaining CLI text or tool results. Search and listing can traverse
 * files that their responses do not name, so their CLI events alone cannot
 * establish a complete manifest. */
export function createAmuxTrackedCheckoutReadObserver({ directory, files }) {
  if (typeof directory !== "string" || !CHECKOUT.test(directory) ||
      !Array.isArray(files) || files.some((file) =>
        typeof file !== "string" || !file || file.startsWith("/") ||
        file.includes("\\") || posix.normalize(file) !== file ||
        file.split("/").some((part) => part === ".." || part === "."))) {
    throw new TypeError("invalid tracked checkout read observer");
  }
  const allowed = new Set(files);
  if (allowed.size !== files.length) {
    throw new TypeError("invalid tracked checkout read observer");
  }
  const pending = new Map();
  const seenIds = new Set();
  const observed = new Set();
  let invalid = false;
  let unenumeratedToolUsed = false;
  let resultSeen = false;
  return Object.freeze({
    observeLine(line) {
      if (invalid || resultSeen) { invalid = true; return; }
      let event;
      try { event = JSON.parse(line); } catch { invalid = true; return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        invalid = true; return;
      }
      if (PASSIVE_EVENTS.has(event.type)) return;
      if (event.type === "assistant") {
        if (!Array.isArray(event.message?.content)) { invalid = true; return; }
        for (const block of event.message.content) {
          if (["text", "thinking", "redacted_thinking"].includes(block?.type)) continue;
          if (block?.type !== "tool_use" || typeof block.id !== "string" ||
              !TOOL_ID.test(block.id) || seenIds.has(block.id) ||
              !["Read", "Grep", "Glob"].includes(block.name)) {
            invalid = true; return;
          }
          seenIds.add(block.id);
          if (block.name === "Read") {
            const path = block.input?.file_path;
            const relative = typeof path === "string" &&
              path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : null;
            if (!relative || !allowed.has(relative)) { invalid = true; return; }
            pending.set(block.id, { kind: "Read", path: relative });
          } else {
            pending.set(block.id, { kind: block.name });
          }
        }
        return;
      }
      if (event.type === "user") {
        if (!Array.isArray(event.message?.content)) { invalid = true; return; }
        for (const block of event.message.content) {
          if (block?.type === "text") continue;
          if (block?.type !== "tool_result" ||
              typeof block.tool_use_id !== "string") {
            invalid = true; return;
          }
          const tool = pending.get(block.tool_use_id);
          if (!tool) { invalid = true; return; }
          pending.delete(block.tool_use_id);
          if (block.is_error !== false) { invalid = true; return; }
          if (tool.kind === "Read") observed.add(tool.path);
          if (tool.kind !== "Read") unenumeratedToolUsed = true;
        }
        return;
      }
      if (event.type === "result") {
        if (event.is_error !== false || event.subtype !== "success") {
          invalid = true; return;
        }
        resultSeen = true;
        return;
      }
      invalid = true;
    },
    finish() {
      return invalid || !resultSeen || pending.size > 0 || unenumeratedToolUsed
        ? { kind: "unverified" }
        : { kind: "complete", files: [...observed].sort() };
    },
  });
}

/** Consume stdout as it arrives. CLI chunks do not align with JSON lines or
 * UTF-8 characters, and raw tool results are released after each line.
 * Call finish only after stdout closes; an earlier result is not authoritative. */
export function createAmuxTrackedCheckoutReadStreamObserver(input) {
  const lines = createAmuxTrackedCheckoutReadObserver(input);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let parts = [];
  let invalid = false;
  let finished = false;
  const feed = (text) => {
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0;
      end = text.indexOf("\n", start)) {
      parts.push(text.slice(start, end));
      lines.observeLine(parts.join(""));
      parts = [];
      start = end + 1;
    }
    if (start < text.length) parts.push(text.slice(start));
  };
  return Object.freeze({
    observeChunk(chunk) {
      if (finished || invalid || !(chunk instanceof Uint8Array)) {
        invalid = true;
        return;
      }
      try { feed(decoder.decode(chunk, { stream: true })); }
      catch { invalid = true; parts = []; }
    },
    finish() {
      if (!finished) {
        finished = true;
        if (!invalid) {
          try { feed(decoder.decode()); }
          catch { invalid = true; }
          if (parts.length > 0) lines.observeLine(parts.join(""));
        }
        parts = [];
      }
      return invalid ? { kind: "unverified" } : lines.finish();
    },
  });
}
