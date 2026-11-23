import { connectedJourneyFields, connectedJourneyPropertiesSchema, CONNECTED_JOURNEY_WINDOW_MS, type ConnectedJourneyProperties, type JourneyReason, type JourneyStage } from "./connectedJourneyShared";

export type ConnectedJourneyRow = { userId: string | null; occurredAt: Date; properties: unknown };
type ParsedRow = { actor: string; time: number; p: ConnectedJourneyProperties };
/** Furthest valid stage a mature attempt without a normal reply reached. */
export const CONNECTED_JOURNEY_LAST_STAGES = ["started", "preview", "ready", "sent"] as const;
export type ConnectedJourneyLastStage = (typeof CONNECTED_JOURNEY_LAST_STAGES)[number];
export const CONNECTED_JOURNEY_REASONS = connectedJourneyFields.journey_reason.unwrap().options;
/**
 * One recorded reason: attempts in the mature cohort that carried it, split by
 * whether a valid normal reply was also observed. One attempt counts once per
 * reason; different reasons on one attempt overlap, so rows do not sum to N.
 */
export type ConnectedJourneyReasonRow = { reason: JourneyReason; unreplied: number; replied: number };
/**
 * Mature attempts without a valid normal reply (N = mature - replied).
 * withReason + withoutReason = N, and the lastStage counts also sum to N.
 * preview is null for Import, which has no preview stage.
 */
export type ConnectedJourneyDropoff = {
  unreplied: number; withReason: number; withoutReason: number;
  lastStage: { started: number; preview: number | null; ready: number; sent: number };
  reasons: ConnectedJourneyReasonRow[];
};
export type ConnectedJourneyGroup = {
  kind: ConnectedJourneyProperties["journey_kind"];
  entry: ConnectedJourneyProperties["journey_entry"];
  continuation: "new" | "existing" | null;
  mature: number; preview: number; ready: number; sent: number; replied: number;
  pending: number; pendingReplied: number;
  cancelled: number; invalidated: number; issue: number; unobserved: number;
  rate: number | null;
  dropoff: ConnectedJourneyDropoff;
};
export function summarizeConnectedJourneys(rows: ConnectedJourneyRow[], now = new Date()) {
  const end = now.getTime();
  const start = end - 30 * CONNECTED_JOURNEY_WINDOW_MS;
  const diagnostics = { invalidProperties: 0, orphan: 0, mismatchedProperties: 0, outsideWindow: 0, reversed: 0, missingReady: 0, missingSend: 0, duplicates: 0 };
  const journeys = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const props = row.properties && typeof row.properties === "object" && !Array.isArray(row.properties) ? row.properties as Record<string, unknown> : {};
    const journey = Object.fromEntries(Object.entries(props).filter(([key]) => key !== "market_tier" && key !== "paid_marketing_eligible"));
    const parsed = connectedJourneyPropertiesSchema.safeParse(journey);
    if (!row.userId || !parsed.success || !Number.isFinite(row.occurredAt.getTime())) { diagnostics.invalidProperties++; continue; }
    const key = JSON.stringify([row.userId, parsed.data.journey_kind, parsed.data.journey_key]);
    const entries = journeys.get(key) ?? [];
    entries.push({ actor: row.userId, time: row.occurredAt.getTime(), p: parsed.data });
    journeys.set(key, entries);
  }
  const groups = new Map<string, ConnectedJourneyGroup>();
  const reasonCounts = new Map<ConnectedJourneyGroup, Map<JourneyReason, ConnectedJourneyReasonRow>>();
  for (const events of journeys.values()) {
    events.sort((a, b) => a.time - b.time);
    const begun = events.find(e => e.p.journey_stage === "started");
    if (!begun) { diagnostics.orphan += events.filter(e => e.time >= start && e.time <= end).length; continue; }
    if (begun.time < start || begun.time > end) continue;
    const groupKey = JSON.stringify([begun.p.journey_kind, begun.p.journey_entry, begun.p.continuation_kind]);
    const group = groups.get(groupKey) ?? {
      kind: begun.p.journey_kind, entry: begun.p.journey_entry, continuation: begun.p.continuation_kind ?? null,
      mature: 0, preview: 0, ready: 0, sent: 0, replied: 0, pending: 0, pendingReplied: 0,
      cancelled: 0, invalidated: 0, issue: 0, unobserved: 0, rate: null,
      dropoff: { unreplied: 0, withReason: 0, withoutReason: 0, lastStage: { started: 0, preview: begun.p.journey_kind === "review_chat" ? 0 : null, ready: 0, sent: 0 }, reasons: [] },
    };
    groups.set(groupKey, group);
    const stages = new Map<JourneyStage, number>();
    // Reasons ride only on cancelled/invalidated/issue, each kept once per
    // attempt, so the same filter that accepts the stage accepts its reason.
    const reasons = new Set<JourneyReason>();
    for (const e of events) {
      if (e.p.journey_entry !== begun.p.journey_entry || e.p.continuation_kind !== begun.p.continuation_kind) { diagnostics.mismatchedProperties++; continue; }
      if (e.time < begun.time) { diagnostics.reversed++; continue; }
      if (e.time > begun.time + CONNECTED_JOURNEY_WINDOW_MS || e.time > end) { diagnostics.outsideWindow++; continue; }
      if (stages.has(e.p.journey_stage)) { diagnostics.duplicates++; continue; }
      stages.set(e.p.journey_stage, e.time);
      if (e.p.journey_reason) reasons.add(e.p.journey_reason);
    }
    const preview = stages.get("preview_ready");
    const ready = stages.get("ready");
    const send = stages.get("send_dispatched");
    const reply = stages.get("reply_observed");
    const readyValid = ready !== undefined && (preview === undefined || ready >= preview);
    const sendValid = readyValid && send !== undefined && send >= ready!;
    const replyValid = sendValid && reply !== undefined && reply >= send!;
    if (ready !== undefined && preview !== undefined && ready < preview) diagnostics.reversed++;
    if (send !== undefined && ready === undefined) diagnostics.missingReady++;
    if (send !== undefined && ready !== undefined && send < ready) diagnostics.reversed++;
    if (reply !== undefined && send === undefined) diagnostics.missingSend++;
    if (reply !== undefined && send !== undefined && reply < send) diagnostics.reversed++;
    const mature = begun.time + CONNECTED_JOURNEY_WINDOW_MS <= end;
    if (mature) {
      group.mature++;
      if (preview !== undefined) group.preview++;
      if (readyValid) group.ready++;
      if (sendValid) group.sent++;
      if (replyValid) group.replied++;
      if (!replyValid && !["cancelled", "invalidated", "issue"].some(stage => stages.has(stage as JourneyStage))) group.unobserved++;
      const counts = reasonCounts.get(group) ?? new Map<JourneyReason, ConnectedJourneyReasonRow>();
      reasonCounts.set(group, counts);
      for (const reason of reasons) {
        const row = counts.get(reason) ?? { reason, unreplied: 0, replied: 0 };
        counts.set(reason, row);
        if (replyValid) row.replied++; else row.unreplied++;
      }
      if (!replyValid) {
        const d = group.dropoff;
        d.unreplied++;
        if (reasons.size) d.withReason++; else d.withoutReason++;
        const last: ConnectedJourneyLastStage = sendValid ? "sent" : readyValid ? "ready" : preview !== undefined && d.lastStage.preview !== null ? "preview" : "started";
        d.lastStage[last]! += 1;
      }
    } else { group.pending++; if (replyValid) group.pendingReplied++; }
    if (stages.has("cancelled")) group.cancelled++;
    if (stages.has("invalidated")) group.invalidated++;
    if (stages.has("issue")) group.issue++;
    group.rate = group.mature ? group.replied / group.mature : null;
  }
  // Most unreplied attempts first; ties keep the contract's reason order.
  for (const [group, counts] of reasonCounts) {
    group.dropoff.reasons = [...counts.values()].sort((a, b) => b.unreplied - a.unreplied || CONNECTED_JOURNEY_REASONS.indexOf(a.reason) - CONNECTED_JOURNEY_REASONS.indexOf(b.reason));
  }
  return { groups: [...groups.values()].sort((a, b) => `${a.entry}:${a.continuation}`.localeCompare(`${b.entry}:${b.continuation}`)), diagnostics };
}
export type ConnectedJourneySummary = ReturnType<typeof summarizeConnectedJourneys>;
