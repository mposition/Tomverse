const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PREFIX = "amux-v4-initial-plan-unresolved:";
type ReceiptStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const receiptKey = (operatorId: string) => `${PREFIX}${encodeURIComponent(operatorId)}`;

export function readPendingInitialPlan(store: ReceiptStore | null, operatorId: string):
  { kind: "none" } | { kind: "pending"; ideaId: string } | { kind: "unavailable" } {
  try {
    if (!store) return { kind: "unavailable" };
    const ideaId = store.getItem(receiptKey(operatorId));
    if (ideaId === null) return { kind: "none" };
    return UUID_V4.test(ideaId) ? { kind: "pending", ideaId } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}

export function reservePendingInitialPlan(store: ReceiptStore | null, operatorId: string, ideaId: string): boolean {
  if (!UUID_V4.test(ideaId)) return false;
  try {
    if (!store || store.getItem(receiptKey(operatorId)) !== null) return false;
    store.setItem(receiptKey(operatorId), ideaId);
    return store.getItem(receiptKey(operatorId)) === ideaId;
  } catch { return false; }
}

export function clearPendingInitialPlan(store: ReceiptStore | null, operatorId: string, ideaId: string): void {
  try {
    if (store?.getItem(receiptKey(operatorId)) === ideaId) {
      store.removeItem(receiptKey(operatorId));
    }
  } catch { /* A stale receipt will trigger read-back on the next mount. */ }
}

type Reply = { status: number; body: unknown };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

const definiteRefusals: Record<string, number> = {
  plan_disabled: 503, content_type_refused: 415, schema_rejected: 400,
  too_large: 413, external_scope_required: 409, not_found: 404,
  integrity_unavailable: 503, ADMIN_REAUTHENTICATION_REQUIRED: 428,
  rate_limited: 429,
};

export function classifyInitialPlanPost(reply: Reply, ideaId: string):
  { kind: "committed"; revisionId: string } | { kind: "refused"; code: string } | { kind: "verify" } {
  const body = record(reply.body);
  if (reply.status === 201 && body?.status === "committed" &&
      body.ideaId === ideaId && body.transferAuthorized === false &&
      typeof body.revisionId === "string" && UUID_V4.test(body.revisionId)) {
    return { kind: "committed", revisionId: body.revisionId };
  }
  if (typeof body?.error === "string" && definiteRefusals[body.error] === reply.status) {
    return { kind: "refused", code: body.error };
  }
  return { kind: "verify" };
}

/** Neither absent nor partial means it is safe to repeat a possibly committed POST. */
export function classifyInitialPlanReadback(reply: Reply, ideaId: string):
  { kind: "committed"; revisionId: string } | { kind: "outcome_unknown" } {
  const body = record(reply.body);
  if (reply.status === 200 && body?.status === "committed" && body.ideaId === ideaId &&
      typeof body.revisionId === "string" && UUID_V4.test(body.revisionId)) {
    return { kind: "committed", revisionId: body.revisionId };
  }
  return { kind: "outcome_unknown" };
}

/** A clean page load can distinguish no plan from a committed plan. An
 * unresolved POST uses classifyInitialPlanReadback instead: absence there is
 * deliberately not permission to retry. */
export function classifyExistingInitialPlan(reply: Reply, ideaId: string):
  { kind: "committed"; revisionId: string } | { kind: "absent" } | { kind: "outcome_unknown" } {
  const committed = classifyInitialPlanReadback(reply, ideaId);
  if (committed.kind === "committed") return committed;
  const body = record(reply.body);
  if (reply.status === 200 && body?.ideaId === ideaId && body.status === "absent" &&
      Object.keys(body).length === 2) return { kind: "absent" };
  return { kind: "outcome_unknown" };
}
