/**
 * Rewinding the AMUX floor to an earlier moment today, from the attempts the
 * office already read. Only attempts are recorded over time, so the past floor
 * says exactly that: a worker sits at its desk only when an attempt of its
 * covered the moment. One at its desk now (busy, or failed with "!") but not
 * then is drawn resting, as nothing records when a failure began; every other
 * place (bench, covered desk) is today's. Pure: no clock, no reads.
 */
import type { AgentOfficeAmuxWorkerState, AgentOfficeAttemptSpan } from "./live";

/** The rewind slider moves in five-minute steps. */
export const REPLAY_STEP_MS = 5 * 60_000;

/** The workers running an attempt at `at` (started at or before it, not yet ended). */
export function busyAt(spans: readonly AgentOfficeAttemptSpan[], at: number): Set<string> {
  const busy = new Set<string>();
  for (const span of spans) {
    const start = Date.parse(span.startedAt);
    const end = span.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(span.endedAt);
    if (Number.isFinite(start) && start <= at && at < end) busy.add(span.worker);
  }
  return busy;
}

/** The state a worker is drawn with at a past moment (see the file comment). */
export function replayState(now: AgentOfficeAmuxWorkerState, busyThen: boolean): AgentOfficeAmuxWorkerState {
  if (busyThen) return "busy";
  return now === "busy" || now === "error" || now === "lost" ? "idle" : now;
}

/** How many slider steps lie between the day's start and now (at least one). */
export function replaySteps(sinceIso: string, now: number): number {
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since) || now <= since) return 1;
  return Math.max(1, Math.ceil((now - since) / REPLAY_STEP_MS));
}

/** The moment a slider step stands for; the last step is now. */
export function replayMoment(sinceIso: string, now: number, step: number): number {
  const steps = replaySteps(sinceIso, now);
  if (step >= steps) return now;
  return Date.parse(sinceIso) + Math.max(0, step) * REPLAY_STEP_MS;
}
