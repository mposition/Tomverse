/**
 * What happens to a discovered model between "a provider listed it" and
 * "we are done with it", as a state machine that can be tested without a
 * database.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §9.
 *
 * ## Why this exists next to ProviderModelCatalogEntry rather than inside it
 *
 * The catalogue entry is an *observation*: the monitor overwrites its `status`
 * on every scan, because that column answers "what did the provider say this
 * morning". A decision written there would be erased by the next run. This
 * table answers a different question -- "what did we decide to do about it" --
 * and nothing but a person changes it.
 *
 * The failure it replaces is measured rather than hypothetical. `newCandidates`
 * is populated only when no catalogue row exists yet, and the same scan writes
 * that row, so a model is named in exactly one daily report and never again.
 * Between 21 July and 22 August 2026 that lost seven first-party models, one of
 * them for twenty-eight days. Every candidate that *did* reach the catalogue
 * was handled the day it appeared. The pipeline worked exactly as long as
 * somebody read that morning's message.
 */

/** What we intend to do about a model. */
export const WORK_ITEM_ACTIONS = [
    "add",
    "upgrade",
    "replace",
    "retire",
    "monitor",
    "no_action",
] as const;
export type WorkItemAction = (typeof WORK_ITEM_ACTIONS)[number];

/**
 * Eleven states, down from the fifteen the audit first sketched.
 *
 * Two collapses, both for the same reason -- a state nobody can act on
 * differently from its neighbour is a state that gets used wrongly:
 *
 *   * `triage_pending` is gone. A freshly discovered item and one "awaiting
 *     triage" are the same thing to everyone who looks at the queue.
 *   * the three verification states (`pricing_`, `access_`, `staging_`) are one
 *     `validation_pending` plus a `pendingValidations` list, because they run in
 *     parallel and a single state could only ever name one of them.
 */
export const WORK_ITEM_STATUSES = [
    "discovered",
    "awaiting_decision",
    "approved",
    "rejected",
    "deferred",
    "implementation_pending",
    "validation_pending",
    "rollout_pending",
    "communication_pending",
    "completed",
    "closed_no_action",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_SEVERITIES = ["critical", "high", "normal"] as const;
export type WorkItemSeverity = (typeof WORK_ITEM_SEVERITIES)[number];

export const WORK_ITEM_CONFIDENCES = ["high", "medium", "low"] as const;
export type WorkItemConfidence = (typeof WORK_ITEM_CONFIDENCES)[number];

export const WORK_ITEM_DECISIONS = ["approve", "reject", "defer"] as const;
export type WorkItemDecision = (typeof WORK_ITEM_DECISIONS)[number];

/**
 * States nothing leaves.
 *
 * `completed` is here as firmly as the two refusals: a finished item that can
 * be reopened is a queue that can be silently rewritten after the fact, and the
 * audit trail would then describe a history that no longer holds. Reopening is
 * a new item, which is also what a model coming back from retirement is.
 */
export const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
    "rejected",
    "completed",
    "closed_no_action",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
    discovered: ["awaiting_decision", "deferred", "closed_no_action"],
    awaiting_decision: ["approved", "rejected", "deferred", "closed_no_action"],
    deferred: ["awaiting_decision", "closed_no_action"],
    approved: ["implementation_pending"],
    implementation_pending: ["validation_pending"],
    validation_pending: ["rollout_pending"],
    // The branch is decided by `communicationRequired`, not by whoever is
    // clicking: see `workItemTransitionRefusal`.
    rollout_pending: ["communication_pending", "completed"],
    communication_pending: ["completed"],
    rejected: [],
    completed: [],
    closed_no_action: [],
};

export type WorkItemTransitionInput = {
    from: WorkItemStatus;
    to: WorkItemStatus;
    /** Whether a decision has been recorded on the item. */
    hasDecision: boolean;
    /** Validations named but not yet satisfied, e.g. ["pricing", "staging"]. */
    pendingValidations: readonly string[];
    /** Whether users have to be told before this item can close. */
    communicationRequired: boolean;
    /** Who is making the change. Automation may create, never decide. */
    actorEmail: string | null;
};

export type WorkItemTransitionRefusal = {
    code:
        | "unknown_status"
        | "terminal"
        | "not_allowed"
        | "decision_missing"
        | "validations_outstanding"
        | "communication_required"
        | "actor_required";
    message: string;
};

export const isWorkItemStatus = (value: unknown): value is WorkItemStatus =>
    typeof value === "string" &&
    (WORK_ITEM_STATUSES as readonly string[]).includes(value);

export const isWorkItemAction = (value: unknown): value is WorkItemAction =>
    typeof value === "string" &&
    (WORK_ITEM_ACTIONS as readonly string[]).includes(value);

/**
 * Whether one transition may be applied, and why not.
 *
 * Returns the refusal rather than throwing so the admin API can answer with it
 * and the caller in a transaction can decide. The rules are the invariants the
 * audit named, in the order they are cheapest to check.
 */
export const workItemTransitionRefusal = (
    input: WorkItemTransitionInput
): WorkItemTransitionRefusal | null => {
    if (!isWorkItemStatus(input.from) || !isWorkItemStatus(input.to)) {
        return { code: "unknown_status", message: "Unknown work item status." };
    }
    if (TERMINAL_WORK_ITEM_STATUSES.has(input.from)) {
        return {
            code: "terminal",
            message: `${input.from} is terminal. Reopening is a new work item, not an edit to this one.`,
        };
    }
    if (!ALLOWED_TRANSITIONS[input.from].includes(input.to)) {
        return {
            code: "not_allowed",
            message: `${input.from} does not lead to ${input.to}.`,
        };
    }
    // Automation discovers and reports; a person decides. Without this the
    // monitor could approve its own findings, which is the whole failure the
    // reconciliation hold exists to prevent one layer down.
    if (!input.actorEmail) {
        return {
            code: "actor_required",
            message: "A work item transition needs the person making it.",
        };
    }
    if (input.to === "approved" && !input.hasDecision) {
        return {
            code: "decision_missing",
            message: "Approving needs the decision and its reason recorded first.",
        };
    }
    if (input.to === "rollout_pending" && input.pendingValidations.length > 0) {
        return {
            code: "validations_outstanding",
            message: `Still unverified: ${input.pendingValidations.join(", ")}.`,
        };
    }
    // A registry row is not the finish line. An item that owes users a notice
    // closes through communication_pending or it does not close.
    if (
        input.from === "rollout_pending" &&
        input.to === "completed" &&
        input.communicationRequired
    ) {
        return {
            code: "communication_required",
            message:
                "This item owes users a notice, so it closes through communication_pending.",
        };
    }
    return null;
};

/**
 * Which timestamp a transition stamps.
 *
 * Kept here rather than at the call site so the two terminal shapes cannot
 * drift: a completed item has `completedAt`, a refused one has `closedAt`, and
 * nothing has both.
 */
export const workItemTimestampField = (
    to: WorkItemStatus
): "completedAt" | "closedAt" | null => {
    if (to === "completed") return "completedAt";
    if (to === "rejected" || to === "closed_no_action") return "closedAt";
    return null;
};

/**
 * The identity a *decision* is made about, as opposed to the identity an
 * observation has.
 *
 * ML-12. A catalogue observation is keyed (provider, apiModel) and correctly
 * so: Qwen serving `ZHIPU/GLM-5.3` and Zhipu serving `glm-5.3` are two true
 * facts about two providers. But they are one model, and asking somebody to
 * decide about it twice -- on two different days, in two unrelated one-line
 * entries -- is how GLM-5.3 was announced three times in three days and added
 * none of them. The same collapse is what stops `kimi-k3`, already shipped
 * under moonshot, being announced as new because Qwen also lists it.
 *
 * Deliberately crude: lower-case, and drop any vendor prefix. It decides only
 * whether we already know about a model, never what to charge for one or where
 * to send a request, so a false merge costs a candidate row rather than money.
 */
export const candidateIdentity = (apiModel: string) => {
    const withoutVendor = apiModel.slice(apiModel.lastIndexOf("/") + 1);
    return withoutVendor.trim().toLowerCase();
};

/**
 * What a scan should do about a model it just saw, given what the queue already
 * holds.
 *
 * The point is the `null` case: an item that exists is *left alone*. A second
 * sighting of a model somebody already rejected must not reopen it, and a
 * sighting of one already approved must not reset its progress -- which is
 * exactly what re-deriving state from today's scan would do.
 */
export const workItemForObservation = (input: {
    existingStatus: WorkItemStatus | null;
    /**
     * True when some ModelRegistryEntry already serves this model, under any
     * provider. Provider-agnostic on purpose -- see `candidateIdentity`.
     */
    alreadyInCatalogue: boolean;
}): { create: true; status: WorkItemStatus } | null => {
    if (input.alreadyInCatalogue) return null;
    if (input.existingStatus !== null) return null;
    return { create: true, status: "discovered" };
};

/**
 * Which of today's observations are worth a person's attention, given
 * everything already known.
 *
 * One function rather than a filter at the call site so the two collapses --
 * "already in the catalogue under any provider" and "already has a work item
 * under any provider" -- cannot be applied in one place and forgotten in the
 * other.
 */
export type ModelObservation = { provider: string; apiModel: string };

/**
 * Where a model was seen, kept beside the decision about it.
 *
 * One decision, several sightings: `glm-5.3` arrived three times over three
 * days -- as `glm-5.3` from Zhipu, `ZHIPU/GLM-5.3` from Qwen and
 * `perplexity/glm-5.3` from Perplexity -- and each report said "new" without
 * saying it was the one from the day before. Collapsing them to one item is
 * right; throwing away the two it collapsed is not, because which providers
 * serve a model is exactly what somebody deciding whether to add it needs.
 */
export type ObservedVia = ModelObservation[];

const sameObservation = (a: ModelObservation, b: ModelObservation) =>
    a.provider === b.provider && a.apiModel === b.apiModel;

/**
 * Adds sightings an item has not recorded, and changes nothing else.
 *
 * Order is preserved and duplicates are dropped, so re-running a scan is a
 * no-op and a genuinely new provider appends. The exact `apiModel` is kept
 * rather than the normalised key: `ZHIPU/GLM-5.3` is what Qwen actually
 * returned, and an operator checking the claim needs the string that was there.
 */
export const mergeObservedVia = (
    existing: readonly ModelObservation[],
    incoming: readonly ModelObservation[]
): { merged: ObservedVia; added: number } => {
    const merged = [...existing];
    let added = 0;
    for (const observation of incoming) {
        if (merged.some((entry) => sameObservation(entry, observation))) continue;
        merged.push(observation);
        added += 1;
    }
    return { merged, added };
};

export const newCandidatesForQueue = (input: {
    observed: readonly ModelObservation[];
    /** Every apiModel the catalogue serves, any provider. */
    catalogueApiModels: readonly string[];
    /** Every apiModel that already has a work item, any provider. */
    queuedApiModels: readonly string[];
}) => {
    const known = new Set(
        [...input.catalogueApiModels, ...input.queuedApiModels].map(candidateIdentity)
    );
    const fresh: Array<ModelObservation & { observedVia: ObservedVia }> = [];
    const byIdentity = new Map<string, (typeof fresh)[number]>();
    for (const observation of input.observed) {
        const identity = candidateIdentity(observation.apiModel);
        const already = byIdentity.get(identity);
        if (already) {
            // Two providers listing the same new model on the same day is one
            // candidate. It is also two facts, and both are kept.
            already.observedVia = mergeObservedVia(already.observedVia, [observation]).merged;
            continue;
        }
        if (known.has(identity)) continue;
        known.add(identity);
        const entry = { ...observation, observedVia: [observation] };
        byIdentity.set(identity, entry);
        fresh.push(entry);
    }
    return fresh;
};

/**
 * Sightings of models the queue already holds, grouped by the item they belong
 * to.
 *
 * The counterpart of the collapse above, across days rather than within one
 * scan: a model somebody is already deciding about, appearing through a
 * provider that had not served it before, is new information about that
 * decision and belongs on that row.
 */
export const observationsForExistingItems = (input: {
    observed: readonly ModelObservation[];
    /** The identities the queue holds, from `candidateIdentity`. */
    queuedIdentities: readonly string[];
}) => {
    const queued = new Set(input.queuedIdentities);
    const byIdentity = new Map<string, ObservedVia>();
    for (const observation of input.observed) {
        const identity = candidateIdentity(observation.apiModel);
        if (!queued.has(identity)) continue;
        const existing = byIdentity.get(identity);
        if (existing) byIdentity.set(identity, mergeObservedVia(existing, [observation]).merged);
        else byIdentity.set(identity, [observation]);
    }
    return byIdentity;
};

/** How long an item has been waiting, in whole days. */
export const workItemAgeDays = (firstSeenAt: Date, now: Date) =>
    Math.max(0, Math.floor((now.getTime() - firstSeenAt.getTime()) / 86_400_000));

/**
 * The states that mean "a person still has to look at this".
 *
 * The daily report reads this rather than a hand-written list, so a new state
 * cannot be added without deciding which side of the report it falls on.
 */
export const OPEN_WORK_ITEM_STATUSES: readonly WorkItemStatus[] =
    WORK_ITEM_STATUSES.filter(
        (status) => !TERMINAL_WORK_ITEM_STATUSES.has(status)
    );
