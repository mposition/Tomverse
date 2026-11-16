"use client";

import { connectedJourneyPropertiesSchema, CONNECTED_JOURNEY_WINDOW_MS, type ConnectedJourneyProperties, type JourneyEntry, type JourneyReason, type JourneyStage } from "./connectedJourneyShared";
import { journeyIdentity, journeyOwnerDisposition, onJourneyIdentityInvalidated } from "./connectedJourneyIdentity";
import { trackConnectedJourneyEvent } from "./productAnalyticsClient";

export type ConnectedJourney = {
  properties: Omit<ConnectedJourneyProperties, "journey_stage" | "journey_reason">;
  owner: string;
  epoch: number;
  startedAt: number;
  stages: Set<JourneyStage>;
  closed?: boolean;
  scope?: string;
  target?: string;
  first?: { conversationId: string; sourceUserMessageId: string };
};
const STORAGE_KEY = "tomverse_connected_journeys_v1";
const journeys = new Map<string, ConnectedJourney>();
let draftJourney: ConnectedJourney | null = null;
const storage = () => typeof window === "undefined" ? null : window.sessionStorage;
const current = (j: ConnectedJourney | null | undefined): j is ConnectedJourney => Boolean(j && !j.closed &&
  j.epoch === journeyIdentity().epoch && journeyOwnerDisposition(j.owner) === "send" &&
  Date.now() - j.startedAt <= CONNECTED_JOURNEY_WINDOW_MS);

onJourneyIdentityInvalidated(() => {
  journeys.clear(); draftJourney = null;
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* Optional storage. */ }
});

export function beginConnectedJourney(entry: JourneyEntry, continuation?: "new" | "existing"): ConnectedJourney | null {
  const { owner, epoch } = journeyIdentity();
  if (!owner || journeyOwnerDisposition(owner) !== "send") return null;
  try {
    const j: ConnectedJourney = { owner, epoch, startedAt: Date.now(), stages: new Set(), properties: {
      journey_key: crypto.randomUUID(), journey_kind: entry.startsWith("review_") ? "review_chat" : "import_continuation",
      journey_entry: entry, ...(continuation ? { continuation_kind: continuation } : {}),
    } };
    journeys.set(j.properties.journey_key, j);
    journeyStep(j, "started");
    return j;
  } catch { return null; }
}

export function journeyStep(j: ConnectedJourney | null | undefined, stage: JourneyStage, reason?: JourneyReason) {
  if (!current(j) || j.stages.has(stage)) return;
  const parsed = connectedJourneyPropertiesSchema.safeParse({ ...j.properties, journey_stage: stage, ...(reason ? { journey_reason: reason } : {}) });
  if (!parsed.success) return;
  trackConnectedJourneyEvent(parsed.data, j);
  j.stages.add(stage);
  if (stage === "cancelled" || stage === "invalidated") {
    j.closed = true;
    if (draftJourney === j) draftJourney = null;
    journeys.delete(j.properties.journey_key);
    persistMarkers();
  }
}

export const connectedDraftScope = (product: string | null, draftKey: string) => `${product === "workspace" ? "review" : product}:${draftKey}`;

export function applyJourneyToDraft(j: ConnectedJourney | null | undefined, scope: string) {
  if (!current(j)) return;
  if (draftJourney && draftJourney !== j) journeyStep(draftJourney, "invalidated", "superseded");
  j.scope = scope; draftJourney = j;
  journeyStep(j, "ready");
}

export function invalidateJourneyDraft(scope: string, reason: JourneyReason = "draft_replaced") {
  if (draftJourney?.scope === scope) journeyStep(draftJourney, "invalidated", reason);
}

export function moveJourneyDraft(from: string, to: string) {
  if (draftJourney?.scope === from) draftJourney.scope = to;
}

export function targetImportJourney(j: ConnectedJourney | null | undefined, conversationId: string) {
  if (current(j)) j.target = conversationId;
}

export function observeJourneyWorkspace(scope: string, conversationId: string | null, owner: string | null, ready: boolean) {
  if (!owner || journeyOwnerDisposition(owner) !== "send") return;
  if (draftJourney?.scope !== scope && draftJourney && draftJourney.first?.conversationId !== conversationId) journeyStep(draftJourney, "invalidated", "scope_changed");
  for (const j of journeys.values()) {
    if (ready && current(j) && !j.scope && j.target === conversationId && j.owner === owner) applyJourneyToDraft(j, scope);
  }
}

/** Captured with the original draft before any asynchronous preparation. */
export const captureJourneyDraft = (scope: string) => current(draftJourney) && draftJourney.scope === scope && !draftJourney.first ? draftJourney : null;

/** Called only after the canonical user Message receipt and final scope check. */
export function bindJourneyFirstSource(j: ConnectedJourney | null, conversationId: string, sourceUserMessageId: string) {
  if (!current(j) || draftJourney !== j || !j.stages.has("ready") || j.first) return;
  j.first = { conversationId, sourceUserMessageId };
}

const persistMarkers = () => {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify([...journeys.values()]
      .filter(j => current(j) && j.first && j.stages.has("send_dispatched"))
      .slice(-20).map(j => ({ properties: j.properties, owner: j.owner, startedAt: j.startedAt, first: j.first }))));
  } catch { /* A blocked sessionStorage must never prevent sending. */ }
};

function restoreMarkers() {
  const { owner, epoch } = journeyIdentity();
  if (!owner || journeyOwnerDisposition(owner) !== "send") return;
  try {
    const stored: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return;
    for (const row of stored.slice(-20)) {
      if (!row || row.owner !== owner || typeof row.startedAt !== "number" || row.startedAt > Date.now() ||
        Date.now() - row.startedAt > CONNECTED_JOURNEY_WINDOW_MS || !row.first ||
        typeof row.first.conversationId !== "string" || typeof row.first.sourceUserMessageId !== "string") continue;
      const props = connectedJourneyPropertiesSchema.safeParse({ ...row.properties, journey_stage: "send_dispatched" });
      if (!props.success || journeys.has(props.data.journey_key)) continue;
      const properties = Object.fromEntries(Object.entries(props.data).filter(([key]) => key !== "journey_stage")) as ConnectedJourney["properties"];
      journeys.set(properties.journey_key, { properties, owner, epoch, startedAt: row.startedAt, first: row.first,
        stages: new Set(["started", "ready", "send_dispatched"]) });
    }
    persistMarkers();
  } catch { /* Missing markers stay unobserved. */ }
}

export function observeJourneyDispatch(owner: string, conversationId: string | null, sourceUserMessageId: string) {
  if (journeyOwnerDisposition(owner) !== "send") return;
  for (const j of journeys.values()) {
    if (current(j) && j.owner === owner && j.first?.conversationId === conversationId && j.first.sourceUserMessageId === sourceUserMessageId) {
      journeyStep(j, "send_dispatched");
      if (draftJourney === j) draftJourney = null;
      persistMarkers();
    }
  }
}

export type JourneyReplyObservation = {
  owner: string;
  epoch: number;
  conversationId: string;
  sourceUserMessageId: string;
  status: "normal" | "incomplete" | "error" | "cancelled" | "timeout";
  nonempty: boolean;
};
export function observeJourneyReply(observation: JourneyReplyObservation) {
  if (observation.epoch !== journeyIdentity().epoch || journeyOwnerDisposition(observation.owner) !== "send") return;
  restoreMarkers();
  for (const j of journeys.values()) {
    if (!current(j) || j.owner !== observation.owner || !j.stages.has("send_dispatched") ||
      j.first?.conversationId !== observation.conversationId || j.first.sourceUserMessageId !== observation.sourceUserMessageId) continue;
    if (observation.status === "normal" && observation.nonempty) journeyStep(j, "reply_observed");
    else journeyStep(j, "issue", observation.status === "normal" ? "empty_response" :
      observation.status === "incomplete" ? "response_incomplete" : observation.status === "cancelled" ? "response_cancelled" :
      observation.status === "timeout" ? "response_timeout" : "response_error");
  }
}

export function hasJourneySource(owner: string, conversationId: string, sourceUserMessageId: string) {
  restoreMarkers();
  return [...journeys.values()].some(j => current(j) && j.owner === owner && j.stages.has("send_dispatched") &&
    j.first?.conversationId === conversationId && j.first.sourceUserMessageId === sourceUserMessageId);
}

export const journeyObservationEpoch = () => journeyIdentity().epoch;
