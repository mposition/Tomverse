import { connectedJourneyPropertiesSchema, CONNECTED_JOURNEY_WINDOW_MS, type ConnectedJourneyProperties, type JourneyStage } from "./connectedJourneyShared";

export type ConnectedJourneyRow = { userId: string | null; occurredAt: Date; properties: unknown };
type ParsedRow = { actor: string; time: number; p: ConnectedJourneyProperties };
export type ConnectedJourneyGroup = {
  kind: ConnectedJourneyProperties["journey_kind"];
  entry: ConnectedJourneyProperties["journey_entry"];
  continuation: "new" | "existing" | null;
  mature: number; preview: number; ready: number; sent: number; replied: number;
  pending: number; pendingReplied: number;
  cancelled: number; invalidated: number; issue: number; unobserved: number;
  rate: number | null;
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
  for (const events of journeys.values()) {
    events.sort((a, b) => a.time - b.time);
    const begun = events.find(e => e.p.journey_stage === "started");
    if (!begun) { diagnostics.orphan += events.length; continue; }
    if (begun.time < start || begun.time > end) { diagnostics.outsideWindow++; continue; }
    const groupKey = JSON.stringify([begun.p.journey_kind, begun.p.journey_entry, begun.p.continuation_kind]);
    const group = groups.get(groupKey) ?? {
      kind: begun.p.journey_kind, entry: begun.p.journey_entry, continuation: begun.p.continuation_kind ?? null,
      mature: 0, preview: 0, ready: 0, sent: 0, replied: 0, pending: 0, pendingReplied: 0,
      cancelled: 0, invalidated: 0, issue: 0, unobserved: 0, rate: null,
    };
    groups.set(groupKey, group);
    const stages = new Map<JourneyStage, number>();
    for (const e of events) {
      if (e.p.journey_entry !== begun.p.journey_entry || e.p.continuation_kind !== begun.p.continuation_kind) { diagnostics.mismatchedProperties++; continue; }
      if (e.time < begun.time) { diagnostics.reversed++; continue; }
      if (e.time > begun.time + CONNECTED_JOURNEY_WINDOW_MS || e.time > end) { diagnostics.outsideWindow++; continue; }
      if (stages.has(e.p.journey_stage)) { diagnostics.duplicates++; continue; }
      stages.set(e.p.journey_stage, e.time);
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
    } else { group.pending++; if (replyValid) group.pendingReplied++; }
    if (stages.has("cancelled")) group.cancelled++;
    if (stages.has("invalidated")) group.invalidated++;
    if (stages.has("issue")) group.issue++;
    group.rate = group.mature ? group.replied / group.mature : null;
  }
  return { groups: [...groups.values()].sort((a, b) => `${a.entry}:${a.continuation}`.localeCompare(`${b.entry}:${b.continuation}`)), diagnostics };
}
export type ConnectedJourneySummary = ReturnType<typeof summarizeConnectedJourneys>;
