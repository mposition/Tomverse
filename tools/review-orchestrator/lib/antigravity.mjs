import { spawn } from "node:child_process";
import { reviewerEnv } from "./env.mjs";

/**
 * Antigravity CLI (`agy`, Gemini on a Google AI plan) as a reviewer.
 *
 * agy 1.5.4 takes its prompt as one NDJSON user event on stdin
 * (`--input-format stream-json`) and reports as NDJSON events
 * (`--output-format stream-json`), as measured on the box for the AMUX v22
 * worker (lib/amux/v22ChannelRun.mjs). The review prompt goes in the event,
 * and the final answer -- the text the verdict is read from -- is the last
 * `result` event's `response`.
 */

const UNKNOWN = { state: "unknown" };
const QUOTA_TIMEOUT_MS = 20_000;
const MAX_QUOTA_BYTES = 128_000;
/** The only file tool a review run may call (agy's stream name for a read). */
const READ_TOOLS = new Set(["read_file"]);
const EVENTS = new Set(["init", "step_update", "result"]);

/** The review prompt as the one user event agy reads on stdin. */
export const antigravityStdin = (prompt) =>
  `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;

/**
 * The reviewer's final answer from agy's event stream, or a reason it cannot
 * be trusted. The file tools reach no path outside the workspace only in
 * agy's `request-review` permission mode (print mode refuses the ask), so a
 * run that started in any other mode, or that called any tool besides a file
 * read, is not a review this server accepts. That check runs after the fact:
 * the deny rules in the provider's args and the review account are what stop
 * the action itself.
 */
export function antigravityAnswer(stdout) {
  const events = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return { reason: "antigravity_stream_invalid" };
    }
  }
  const [first] = events;
  if (first?.event !== "init" || first.init?.permission_mode !== "request-review") {
    return { reason: "antigravity_permission_mode" };
  }
  let result = null;
  for (const event of events) {
    if (!event || !EVENTS.has(event.event)) return { reason: "antigravity_event_unexpected" };
    if (event.event === "result") result = event.result;
    if (event.event !== "step_update") continue;
    const step = event.step_update;
    if (!step || typeof step !== "object" || Object.hasOwn(step, "subagent_info")) {
      return { reason: "antigravity_step_unexpected" };
    }
    if (step.step_type === "tool" && !READ_TOOLS.has(step.tool_name)) {
      return { reason: "antigravity_tool_refused" };
    }
  }
  if (!result || result.status !== "SUCCESS" || typeof result.response !== "string" ||
      result.response.trim() === "") return { reason: "antigravity_no_result" };
  return { text: result.response };
}

/**
 * The quota from `agy -p /usage --output-format json` (no model turn, zero
 * tokens; measured on agy 1.5.4). The plan groups models and each group has
 * a weekly and a five-hour bucket. A Gemini reviewer draws on the "Gemini
 * Models" group, so the less-remaining bucket of that group is what is left.
 */
export function antigravityQuotaFromUsage(body, now = Date.now()) {
  if (!body || typeof body !== "object" || body.status !== "SUCCESS" ||
      body.command?.name !== "usage" || !Array.isArray(body.command?.data?.groups)) return UNKNOWN;
  const group = body.command.data.groups.find((row) => row && row.name === "Gemini Models");
  if (!group || !Array.isArray(group.buckets) || group.buckets.length === 0) return UNKNOWN;
  const remaining = [];
  for (const bucket of group.buckets) {
    const fraction = bucket?.remaining_fraction;
    const reset = typeof bucket?.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
    // A bucket whose reset already passed is an old reading, not the account now.
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1 ||
        !Number.isFinite(reset) || reset <= now) return UNKNOWN;
    remaining.push(fraction * 100);
  }
  const remainingPercent = Math.round(Math.min(...remaining) * 10) / 10;
  return { state: remainingPercent > 0 ? "available" : "exhausted", remainingPercent };
}

/**
 * The usage panel only. The deny rules make even a CLI that took "/usage"
 * for a prompt unable to run a tool.
 */
export const ANTIGRAVITY_USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--settings",
  JSON.stringify({ permissions: { deny: ["command(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"] } })];

/** Read the reviewer's own agy login's quota; unknown on any failure. */
export function antigravityQuota(provider, { spawnChild = spawn, now = Date.now() } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(UNKNOWN), QUOTA_TIMEOUT_MS);
    try {
      child = spawnChild(provider.command, ANTIGRAVITY_USAGE_ARGS, {
        stdio: ["ignore", "pipe", "ignore"],
        env: reviewerEnv(provider),
      });
    } catch {
      return finish(UNKNOWN);
    }
    child.on("error", () => finish(UNKNOWN));
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_QUOTA_BYTES) finish(UNKNOWN);
    });
    child.on("close", (code) => {
      if (code !== 0) return finish(UNKNOWN);
      try {
        finish(antigravityQuotaFromUsage(JSON.parse(output), now));
      } catch {
        finish(UNKNOWN);
      }
    });
  });
}
