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

import {
    candidateDecisionKey,
    candidateFamilyIdentity,
    candidateRepresentativeRank,
    decisionKeyFamily,
    decisionSuppressesCandidateIdentity,
    modelStage,
    newestByModelLine,
    shouldQueueModelCandidate,
    supersedingServedModel,
} from "@/lib/modelLifecycleTriage";

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
 * What an operator decided on one event of the history, when the event is a
 * decision rather than a step.
 *
 * Kept on the event, not only on the item, because the item says what is true
 * now and a reopened item no longer carries the exclusion it was reopened from.
 */
export const WORK_ITEM_EVENT_DECISIONS = ["adopt", "exclude", "reopen"] as const;
export type WorkItemEventDecision = (typeof WORK_ITEM_EVENT_DECISIONS)[number];

/**
 * Why an operator excluded a model family, as a choice rather than a sentence.
 *
 * A short list so exclusions can be counted and read back; `other` carries a
 * written reason and the database refuses it without one.
 */
export const WORK_ITEM_EXCLUSION_REASONS = [
    "served_by_better_model",
    "duplicate_alias",
    "no_product_path",
    "insufficient_advantage",
    "unstable_provider",
    "other",
] as const;
export type WorkItemExclusionReason = (typeof WORK_ITEM_EXCLUSION_REASONS)[number];

export const isWorkItemExclusionReason = (
    value: unknown
): value is WorkItemExclusionReason =>
    typeof value === "string" &&
    (WORK_ITEM_EXCLUSION_REASONS as readonly string[]).includes(value);

/**
 * Closed states: no longer waiting on anyone, and outside every open count.
 *
 * `completed` and `rejected` are also final. A finished item that can be
 * reopened is a queue that can be silently rewritten after the fact.
 *
 * `closed_no_action` -- shown to operators as "excluded" -- is the one closed
 * state with a way back, and only one: an explicit reopen to `discovered`
 * (`REOPENABLE_WORK_ITEM_STATUSES`). An exclusion is a judgement about a model
 * at a price, a capability and a product line-up, all of which move; a state
 * nobody could ever reopen would leave a later better answer with nowhere to
 * go, because `(provider, apiModel, action)` is unique and a second item for
 * the same model cannot be filed. Scans still never reopen it: a sighting of an
 * item that exists leaves it alone (`workItemForObservation`), whatever its
 * state. The reopen is a transition like any other, written to the history
 * with the person's name and reason, so the history still describes what
 * happened.
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
    closed_no_action: ["discovered"],
};

/** Closed states an operator may explicitly return to the queue. */
export const REOPENABLE_WORK_ITEM_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
    "closed_no_action",
]);

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
    if (
        TERMINAL_WORK_ITEM_STATUSES.has(input.from) &&
        !(
            REOPENABLE_WORK_ITEM_STATUSES.has(input.from) &&
            ALLOWED_TRANSITIONS[input.from].includes(input.to)
        )
    ) {
        return {
            code: "terminal",
            message: REOPENABLE_WORK_ITEM_STATUSES.has(input.from)
                ? `${input.from} only reopens to discovered.`
                : `${input.from} is terminal and cannot be reopened.`,
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
 * The structured record an exclusion or a reopen carries, checked before any
 * write.
 *
 * The same rules as the history table's CHECK constraints, here so the API can
 * answer with a reason rather than a constraint violation. The analysis the
 * queue showed is recorded beside the operator's reason, never as it: an
 * automatic suggestion written into the reason column reads, a month later, as
 * the reason a person gave.
 */
export type WorkItemDecisionRecord =
    | {
          decision: "exclude";
          reasonCode: WorkItemExclusionReason;
          operatorReason: string | null;
      }
    | { decision: "reopen"; operatorReason: string }
    | { decision: "adopt"; operatorReason: string };

export const OPERATOR_REASON_MAX_LENGTH = 1_000;

export const workItemDecisionRecordRefusal = (
    record: WorkItemDecisionRecord
): { code: "reason_required" | "unknown_reason"; message: string } | null => {
    const written = record.operatorReason?.trim() ?? "";
    if (written.length > OPERATOR_REASON_MAX_LENGTH) {
        return {
            code: "reason_required",
            message: `A reason is at most ${OPERATOR_REASON_MAX_LENGTH} characters.`,
        };
    }
    if (record.decision === "exclude") {
        if (!isWorkItemExclusionReason(record.reasonCode)) {
            return { code: "unknown_reason", message: "Unknown exclusion reason." };
        }
        if (record.reasonCode === "other" && !written) {
            return {
                code: "reason_required",
                message: "An exclusion for another reason needs that reason written down.",
            };
        }
        return null;
    }
    if (!written) {
        return {
            code: "reason_required",
            message:
                record.decision === "adopt"
                    ? "An adoption needs the operator's reason."
                    : "Reopening an excluded model needs a reason.",
        };
    }
    return null;
};

/** States an adoption record may stand in: where the adoption walk ends. */
export const ADOPTION_RECORD_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
    "validation_pending",
    "rollout_pending",
    "communication_pending",
]);

/** The transition each decision record makes. */
export const workItemDecisionTarget = (
    decision: "exclude" | "reopen"
): WorkItemStatus => (decision === "exclude" ? "closed_no_action" : "discovered");

/**
 * A stable fingerprint of an analysis sentence, for comparing what a panel
 * showed with what the server computes without sending the sentence back.
 *
 * FNV-1a over UTF-16 code units, twice with different offsets, as 16 hex
 * digits. Not a security boundary -- the server records its own text and an
 * operator is already authorised to decide -- only a cheap equality check that
 * behaves the same in the browser and on the server with no async crypto.
 */
export const analysisFingerprint = (text: string) => {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ text.length;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
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
    // One identity for both layers, not two. The report used to group only by
    // the bare id while the queue grouped by family, so the daily mail could
    // announce `gemini-2.5-flash-preview-05-20` as new on a morning when the
    // queue had long since collapsed it into a family somebody had decided
    // about. Two answers to "is this the same model" is one answer too many.
    return candidateFamilyIdentity(apiModel);
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
 * A provider's own statement that two request ids resolve to one model.
 *
 * This is deliberately evidence, not another model-name heuristic. xAI's
 * `/v1/language-models` response, for example, returns a canonical `id` plus
 * requestable `aliases`. Treating `grok-4.20-non-reasoning` and its `-gv2`
 * revision as unrelated made the operator decide twice about one upstream
 * model. Conversely, stripping arbitrary suffixes would silently merge models
 * no provider said were equivalent.
 */
export type ModelAliasEvidence = {
    aliasApiModel: string;
    canonicalApiModel: string;
};

const aliasFamilyMap = (aliases: readonly ModelAliasEvidence[]) => {
    const direct = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const alias of aliases) {
        const from = candidateFamilyIdentity(alias.aliasApiModel);
        const to = candidateFamilyIdentity(alias.canonicalApiModel);
        if (!from || !to || from === to || ambiguous.has(from)) continue;

        const existing = direct.get(from);
        if (existing && existing !== to) {
            // Alias evidence is gathered across every provider. If two of them
            // assign the same request id to different canonical models, neither
            // statement is safe enough to collapse an operator decision. Keep
            // the id independent instead of making row order choose a winner.
            direct.delete(from);
            ambiguous.add(from);
            continue;
        }
        direct.set(from, to);
    }
    return direct;
};

/** Build once per catalogue snapshot; callers use it in bounded row loops. */
export const createModelDecisionIdentityResolver = (
    aliases: readonly ModelAliasEvidence[] = []
) => {
    const direct = aliasFamilyMap(aliases);
    return (apiModel: string) => {
        let identity = candidateFamilyIdentity(apiModel);
        const visited = new Set<string>();
        while (!visited.has(identity)) {
            visited.add(identity);
            const next = direct.get(identity);
            if (!next) break;
            identity = next;
        }
        return identity;
    };
};

/** One decision identity after applying provider-declared alias evidence. */
export const modelDecisionIdentity = (
    apiModel: string,
    aliases: readonly ModelAliasEvidence[] = []
) => createModelDecisionIdentityResolver(aliases)(apiModel);

/** Alias statements that survived conflict handling and resolve to one family. */
export const trustedModelAliasEvidence = (
    aliases: readonly ModelAliasEvidence[] = []
) => {
    const decisionIdentity = createModelDecisionIdentityResolver(aliases);
    return aliases.filter(
        (alias) =>
            decisionIdentity(alias.aliasApiModel) ===
            decisionIdentity(alias.canonicalApiModel)
    );
};

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

/** Why a model this scan saw was not put in front of a person. */
export const CANDIDATE_SUPPRESSIONS = [
    "not_reviewable",
    "already_served",
    "already_decided",
    "superseded_by_served_version",
    "superseded_within_scan",
] as const;
export type CandidateSuppression = (typeof CANDIDATE_SUPPRESSIONS)[number];

export type SuppressedCandidate = {
    apiModel: string;
    provider: string;
    reason: CandidateSuppression;
    /** For the two version reasons, the model it lost to. */
    supersededBy?: string;
};

export type QueueCandidateSelection = {
    fresh: Array<ModelObservation & { observedVia: ObservedVia }>;
    suppressed: SuppressedCandidate[];
};

/**
 * Which of today's observations become work items, and what happened to the
 * rest.
 *
 * The second list is not bookkeeping. Every filter here removes a model from a
 * person's view, and a filter whose output nobody can count is a filter nobody
 * can find a fault in -- which is how the OpenAI chat-prefix guess went a month
 * without anyone noticing what it had dropped.
 */
export const selectQueueCandidates = (input: {
    observed: readonly ModelObservation[];
    /** Every apiModel the catalogue serves, any provider. */
    catalogueApiModels: readonly string[];
    /** Every apiModel that already has a work item, any provider. */
    queuedApiModels: readonly string[];
    /**
     * The decision keys stored on those work items, from
     * `candidateDecisionKey` at the time each was filed.
     *
     * Read alongside `queuedApiModels` rather than instead of it: a key written
     * under an older normalisation still has to suppress what it suppressed
     * then, and a row filed before keys existed has only its apiModel.
     */
    queuedDecisionKeys?: readonly string[];
    /** Provider-declared aliases collected from the same catalogue state. */
    aliases?: readonly ModelAliasEvidence[];
}): QueueCandidateSelection => {
    const decisionIdentity = createModelDecisionIdentityResolver(input.aliases);
    const servedFamilies = new Set(
        input.catalogueApiModels.map(decisionIdentity)
    );
    const decisionKeysByFamily = new Map<string, string[]>();
    for (const key of [
        ...input.queuedApiModels.map((apiModel) => candidateDecisionKey(apiModel)),
        ...(input.queuedDecisionKeys ?? []),
    ]) {
        const family = decisionIdentity(decisionKeyFamily(key));
        const separator = key.lastIndexOf("@");
        const stage = separator < 0 ? "stable" : key.slice(separator + 1) || "stable";
        const normalizedKey = `${family}@${stage}`;
        const held = decisionKeysByFamily.get(family);
        if (held) held.push(normalizedKey);
        else decisionKeysByFamily.set(family, [normalizedKey]);
    }
    const fresh: Array<ModelObservation & { observedVia: ObservedVia }> = [];
    const suppressed: SuppressedCandidate[] = [];
    const byIdentity = new Map<string, (typeof fresh)[number]>();
    const note = (
        observation: ModelObservation,
        reason: CandidateSuppression,
        supersededBy?: string
    ) => {
        suppressed.push({
            apiModel: observation.apiModel,
            provider: observation.provider,
            reason,
            ...(supersededBy ? { supersededBy } : {}),
        });
    };

    for (const observation of input.observed) {
        // Callers normally pass the monitor's already-filtered candidate set,
        // but the historical backfill reads observation rows directly. Keep
        // the eligibility policy here too so neither path can queue preview,
        // beta, experimental or otherwise unsupported models.
        if (!shouldQueueModelCandidate(observation.apiModel)) {
            note(observation, "not_reviewable");
            continue;
        }
        const identity = decisionIdentity(observation.apiModel);
        const already = byIdentity.get(identity);
        if (already) {
            // Two providers listing the same new model on the same day is one
            // candidate. It is also two facts, and both are kept.
            already.observedVia = mergeObservedVia(already.observedVia, [observation]).merged;
            if (
                candidateRepresentativeRank(observation.apiModel) <
                candidateRepresentativeRank(already.apiModel)
            ) {
                already.provider = observation.provider;
                already.apiModel = observation.apiModel;
            }
            continue;
        }
        if (servedFamilies.has(identity)) {
            note(observation, "already_served");
            continue;
        }
        const decided = (decisionKeysByFamily.get(identity) ?? []).some((key) =>
            decisionSuppressesCandidateIdentity(
                key,
                identity,
                modelStage(observation.apiModel)
            )
        );
        if (decided) {
            note(observation, "already_decided");
            continue;
        }
        const supersededBy = supersedingServedModel(
            observation.apiModel,
            input.catalogueApiModels
        );
        if (supersededBy) {
            note(observation, "superseded_by_served_version", supersededBy);
            continue;
        }
        const entry = { ...observation, observedVia: [observation] };
        byIdentity.set(identity, entry);
        fresh.push(entry);
    }

    // One line, one decision. Two generations of the same line arriving on the
    // same morning is one question -- "do we want the new one" -- and filing
    // both puts the answer to the older one in front of somebody who has not
    // yet answered the newer.
    const newest = newestByModelLine(fresh, (entry) => entry.apiModel);
    const kept = new Set(newest);
    for (const entry of fresh) {
        if (kept.has(entry)) continue;
        note(
            entry,
            "superseded_within_scan",
            newest.find(
                (candidate) =>
                    candidate !== entry &&
                    supersedingServedModel(entry.apiModel, [candidate.apiModel])
            )?.apiModel
        );
    }

    return { fresh: newest, suppressed };
};

/** The candidates alone, for callers that do not report what was filtered. */
export const newCandidatesForQueue = (input: {
    observed: readonly ModelObservation[];
    catalogueApiModels: readonly string[];
    queuedApiModels: readonly string[];
    queuedDecisionKeys?: readonly string[];
    aliases?: readonly ModelAliasEvidence[];
}) => selectQueueCandidates(input).fresh;

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
    aliases?: readonly ModelAliasEvidence[];
}) => {
    const decisionIdentity = createModelDecisionIdentityResolver(input.aliases);
    const queued = new Set(
        input.queuedIdentities.map(decisionIdentity)
    );
    const byIdentity = new Map<string, ObservedVia>();
    for (const observation of input.observed) {
        const identity = decisionIdentity(observation.apiModel);
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

/**
 * The states an adoption walks through, from wherever the item is standing.
 *
 * Creating the registry row *is* the implementation step, so an adopted item
 * has to arrive at `validation_pending` -- pricing, access and staging are
 * still owed, and that is the state that says so. Getting there from
 * `discovered` is four hops, and the alternative was asking the operator to
 * click through them by hand before the adopt button would appear.
 *
 * Every hop is real and is written to the history with the operator's name on
 * it; none of them is skipped or synthesised. What this function removes is the
 * clicking, not the record. The `approve` hop carries the decision, because the
 * state machine will not enter `approved` without one -- and filling a
 * registry form in is the decision.
 *
 * Returns an empty path for an item already at or past `validation_pending`
 * (the row is being created for an item somebody had already walked forward),
 * and `null` when there is no legitimate way from here -- a terminal item, or
 * one sitting in a state that adoption is not the answer to.
 */
export const adoptionTransitionPath = (
    from: WorkItemStatus
): WorkItemStatus[] | null => {
    switch (from) {
        case "discovered":
        case "deferred":
            return [
                "awaiting_decision",
                "approved",
                "implementation_pending",
                "validation_pending",
            ];
        case "awaiting_decision":
            return ["approved", "implementation_pending", "validation_pending"];
        case "approved":
            return ["implementation_pending", "validation_pending"];
        case "implementation_pending":
            return ["validation_pending"];
        // Already past the point this walk exists to reach. The row still gets
        // created and linked; the queue position is left where it is.
        case "validation_pending":
        case "rollout_pending":
        case "communication_pending":
            return [];
        default:
            return null;
    }
};

/**
 * The exact (provider, api model) pairs a scan has seen for a work item.
 *
 * The pair and not its halves. Taking the providers from one sighting and the
 * identifier from another allows a combination nothing ever served: Qwen
 * carrying `ANTHROPIC/CLAUDE-FABLE-5-1` and Anthropic carrying
 * `claude-fable-5-1` would, split apart, permit a row telling Qwen to serve
 * `claude-fable-5-1` -- a string that provider has never returned, sent
 * upstream on every request.
 *
 * Shared rather than duplicated. Adoption refuses on what these pairs say and
 * the queue cleanup closes on it, and two readings of the same evidence that
 * drift apart is one surface refusing what the other has already thrown away.
 */
export const observedPairsOf = (
    workItem: {
        provider: string;
        apiModel: string;
        evidence: unknown;
    } | null
): Array<{ provider: string; apiModel: string }> => {
    if (!workItem) return [];
    const evidence =
        workItem.evidence &&
        typeof workItem.evidence === "object" &&
        !Array.isArray(workItem.evidence)
            ? (workItem.evidence as Record<string, unknown>)
            : null;
    const observedVia = Array.isArray(evidence?.observedVia) ? evidence.observedVia : [];
    const pairs = observedVia
        .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const sighting = entry as { provider?: unknown; apiModel?: unknown };
            return typeof sighting.provider === "string" &&
                typeof sighting.apiModel === "string"
                ? { provider: sighting.provider, apiModel: sighting.apiModel }
                : null;
        })
        .filter((pair): pair is { provider: string; apiModel: string } => Boolean(pair));
    // An item filed before sightings were recorded has only the pair it was
    // filed under, which is the pair the scan saw.
    return pairs.length
        ? pairs
        : [{ provider: workItem.provider, apiModel: workItem.apiModel }];
};
