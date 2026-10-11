// Presentation/measurement metadata is not execution or usage evidence. Keep
// this projection separate from the init/assistant/terminal-result contract.
// Unknown event families still fail closed; never ignore every system event.
const PASSIVE_SYSTEM = new Set(["status", "ui_invalidate", "thinking_tokens",
  "turn_duration"]);
const MAX_METADATA_BYTES = 8_192;
export const AMUX_V4_MAX_PASSIVE_EVENTS = 512;

const record = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value);
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
// New neutral fields may be added by the pinned CLI, but capability changes,
// execution, retries and answer-bearing fields cannot hide in that extension.
const unsafeKey = (key) => /tool|mcp|skill|plugin|agent|permission|command|exec|hook|retry|model|prompt|content|message|result|response|request|output|input|file|path|memory|task|sessionstate/i
  .test(key.replace(/[^a-z0-9]/gi, "")) ||
  ["__proto__", "constructor", "prototype"].includes(key);

function neutralExtensions(value, exempt) {
  let nodes = 0;
  const visit = (item, depth, top = false) => {
    nodes += 1;
    if (nodes > 256 || depth > 6) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 4_096;
    if (Array.isArray(item)) return item.length <= 64 &&
      item.every((child) => visit(child, depth + 1));
    if (!record(item)) return false;
    return Object.entries(item).every(([key, child]) =>
      (top && exempt.has(key)) ||
      (key.length <= 64 && !unsafeKey(key) && visit(child, depth + 1)));
  };
  return visit(value, 0, true);
}

const rejected = (rejectionPoint, security = false) => ({
  kind: "rejected", failureReason: security ? "security_no_tools_violation" :
    "output_contract_mismatch", rejectionPoint,
});

/** Return only a classification. No metadata text, IDs or token estimates
 * escape this adapter, and none can substitute for a verified final result. */
export function inspectAmuxV4ClaudePassiveEvent(event, { initSeen }) {
  const system = event?.type === "system" && PASSIVE_SYSTEM.has(event.subtype);
  const rate = event?.type === "rate_limit_event";
  if (!system && !rate) return { kind: "not_passive" };
  const point = rate ? "rate_limit_shape" : event.subtype === "ui_invalidate"
    ? "ui_invalidate_shape" : "status_shape";
  if (!record(event) || Buffer.byteLength(JSON.stringify(event), "utf8") >
      MAX_METADATA_BYTES) return rejected(point);
  if (event.subtype !== "ui_invalidate" && !initSeen) {
    return { kind: "not_passive" };
  }
  if (["uuid", "session_id"].some((key) => event[key] !== undefined &&
      (typeof event[key] !== "string" || event[key].length > 128))) {
    return rejected(point);
  }
  const modes = [event.permissionMode, event.permission_mode]
    .filter((mode) => mode !== undefined);
  if (modes.some((mode) => !["default", "manual"].includes(mode)) ||
      (modes.length === 2 && modes[0] !== modes[1])) {
    return rejected(point, true);
  }
  const exempt = new Set(["type", "subtype", "uuid", "session_id",
    "permissionMode", "permission_mode"]);
  if (rate) {
    if (!record(event.rate_limit_info)) return rejected(point);
  } else if (event.subtype === "status") {
    if (event.status !== null && event.status !== "requesting") {
      return rejected(point);
    }
  } else if (event.subtype === "ui_invalidate") {
    if (event.event !== "ui.render" || (event.instances !== undefined &&
        (!Array.isArray(event.instances) || event.instances.length !== 0))) {
      return rejected(point);
    }
  } else if (event.subtype === "thinking_tokens") {
    if (!counter(event.estimated_tokens) ||
        !counter(event.estimated_tokens_delta) ||
        event.estimated_tokens_delta > event.estimated_tokens) {
      return rejected(point);
    }
  } else if (event.subtype === "turn_duration") {
    if (!counter(event.durationMs) ||
        ["budgetTokens", "budgetLimit", "budgetNudges", "messageCount"]
          .some((key) => event[key] !== undefined && !counter(event[key]))) {
      return rejected(point);
    }
    for (const key of ["durationMs", "budgetTokens", "budgetLimit",
      "budgetNudges", "messageCount"]) exempt.add(key);
    for (const key of ["pendingBackgroundAgentCount", "pendingWorkflowCount"]) {
      if (event[key] !== undefined && event[key] !== 0) return rejected(point, true);
      exempt.add(key);
    }
  }
  if (!neutralExtensions(event, exempt)) return rejected(point);
  return { kind: "passive" };
}
