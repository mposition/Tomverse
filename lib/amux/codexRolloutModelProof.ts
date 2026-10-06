import type { AmuxCliUsageObservation } from "./cliUsageObservationCore";

const MODEL = /^[A-Za-z0-9._/\[\]-]{1,160}$/;
const THREAD = /^[0-9a-f-]{36}$/i;
const MAX_LINE_BYTES = 1_048_576;
const MAX_LINES = 100_000;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/** The public exec JSONL names a thread, but not the served model. */
export function codexExecThreadId(lines: Iterable<string>): string | null {
  let threadId: string | null = null;
  let count = 0;
  try {
    for (const line of lines) {
      if (++count > MAX_LINES || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
        return null;
      if (!line.trim()) continue;
      const event = object(JSON.parse(line));
      if (!event) return null;
      if (event.type === "thread.started") {
        if (threadId !== null || typeof event.thread_id !== "string" ||
            !THREAD.test(event.thread_id)) return null;
        threadId = event.thread_id;
      }
    }
  } catch { return null; }
  return threadId;
}

/** A fresh, private CODEX_HOME rollout must name the same thread and exactly
 * one served model. This never treats the requested model as an attestation. */
export function codexRolloutServedModel(threadId: string,
  lines: Iterable<string>): string | null {
  if (!THREAD.test(threadId)) return null;
  let sessionCount = 0;
  let model: string | null = null;
  let contextCount = 0;
  let count = 0;
  try {
    for (const line of lines) {
      if (++count > MAX_LINES || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
        return null;
      if (!line.trim()) continue;
      const event = object(JSON.parse(line));
      const payload = object(event?.payload);
      if (!event || !payload) return null;
      if (event.type === "session_meta") {
        if (++sessionCount !== 1 || payload.id !== threadId) return null;
      }
      if (event.type === "turn_context") {
        if (typeof payload.model !== "string" || !MODEL.test(payload.model) ||
            payload.model.split("/").some((part) => !part || part === "." ||
              part === "..") ||
            model !== null && model !== payload.model) return null;
        model = payload.model;
        contextCount += 1;
      }
    }
  } catch { return null; }
  return sessionCount === 1 && contextCount > 0 ? model : null;
}

export function withCodexRolloutModelProof(observation: AmuxCliUsageObservation,
  servedModel: string | null): AmuxCliUsageObservation {
  if (observation.cli !== "codex" || observation.observed === null ||
      observation.completeness !== "reported_complete" ||
      servedModel === null || !MODEL.test(servedModel) ||
      observation.models.length !== 0) return observation;
  return { ...observation, models: [{ modelId: servedModel,
    observed: observation.observed }] };
}
