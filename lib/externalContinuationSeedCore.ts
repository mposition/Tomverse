/**
 * Which turns of an imported conversation become this turn's context, and what
 * had to be left out.
 *
 * Policy: docs/policy/external-conversation-continuation.md §4.
 *
 * ## Why this is deterministic and has no model in it
 *
 * The obvious design is to summarise the source with an LLM. That would make
 * every bridged turn depend on a paid call whose output nobody reviewed, and
 * it would make the seed a *claim about* the source rather than the source's
 * own words — so a wrong summary would be indistinguishable from a wrong
 * memory, with none of the memory programme's validator or approval steps in
 * front of it. docs/policy/external-conversation-continuation.md §4 fixes the
 * MVP as a deterministic window instead: the most
 * recent user/assistant turns, in source order, under a hard token cap.
 *
 * It is also why this module has no dependency on the memory release. The
 * seed is built from rows the user imported and can see; nothing here reads a
 * `MemoryItem`, a candidate, or an extraction run.
 *
 * ## What never enters the seed
 *
 * `system`, `developer`, `tool` and any unknown role are dropped rather than
 * relabelled (docs/policy/external-conversation-import-and-memory.md §5.6 keeps
 * them out of the store in the first place, and this is the second refusal). Attachments were never imported, so
 * there is nothing to copy; what the seed carries instead is the *count* of
 * what is missing, so the screen can say so.
 *
 * ## Why the cap is a hard cap and not a target
 *
 * A source conversation can be thousands of turns. Sending the whole
 * transcript on every turn is forbidden by
 * docs/policy/external-conversation-import-and-memory.md §6 and would
 * be priced against the user's credits every time. The window is taken from
 * the end — the turns nearest to where the user stopped — and stops the moment
 * the next turn would not fit whole. Half a turn is not a turn: a truncated
 * assistant answer in the middle of a sentence is worse context than its
 * absence, and it would make the "N messages were used" disclosure false.
 *
 * Pure: no database, no clock, no provider. The caller supplies rows and gets
 * a plan.
 */

import { estimateTextTokens } from "@/lib/chatTokenEstimate";

/**
 * Bumped whenever the *selection* changes — the window rule, the role filter,
 * the cap. Stored on the bridge so a conversation records which rule built its
 * first seed, and so a later rule can be rolled out without rewriting what
 * older conversations were told.
 *
 * The rendering has its own version (`lib/externalContinuationSeedPrompt.ts`),
 * for the same reason `mem-context-v1` is separate from retrieval: changing
 * the words is not changing the choice.
 */
export const CONTINUATION_SEED_VERSION = "ext-seed-v1";

/**
 * The cap, in estimated input tokens, on everything the seed contributes.
 *
 * Deliberately small. This is context the user did not type on this turn and
 * is charged for on every turn of the conversation, so the number is chosen to
 * be a recognisable slice of a recent exchange rather than "as much as fits".
 * The value is central here and nowhere else: a second cap somewhere would
 * make the priced figure and the sent figure two different numbers, which is
 * the failure the shared token estimator exists to prevent.
 */
export const CONTINUATION_SEED_TOKEN_BUDGET = 3_000;

/** Per-message ceiling, so one enormous turn cannot eat the whole window. */
export const CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT = 4_000;

/**
 * The roles a seed may carry. The same two `ExternalMessage.role` admits —
 * stated again here because this module must not start accepting a third if
 * that constraint is ever widened for another purpose.
 */
export const CONTINUATION_SEED_ROLES = ["user", "assistant"] as const;

export type ContinuationSeedRole = (typeof CONTINUATION_SEED_ROLES)[number];

export const isContinuationSeedRole = (
    value: unknown
): value is ContinuationSeedRole =>
    typeof value === "string" &&
    (CONTINUATION_SEED_ROLES as readonly string[]).includes(value);

export type ContinuationSourceMessage = {
    role: string;
    ordinal: number;
    content: string;
    /**
     * Whether import itself had to shorten this message
     * (docs/policy/external-conversation-import-and-memory.md §5.4).
     */
    truncated: boolean;
};

export type ContinuationSeedTurn = {
    role: ContinuationSeedRole;
    /** The source's own ordinal, preserved. Never renumbered. */
    ordinal: number;
    text: string;
    /** True when import truncated it, or when this module did, or both. */
    shortened: boolean;
};

export type ContinuationSeedPlan = {
    seedVersion: typeof CONTINUATION_SEED_VERSION;
    turns: ContinuationSeedTurn[];
    /** Ordinal window actually used. Both 0 when nothing was selected. */
    fromOrdinal: number;
    toOrdinal: number;
    /** How many stored messages the source snapshot has in total. */
    sourceMessageCount: number;
    /** Selected turns whose text is not complete. */
    truncatedCount: number;
    /**
     * Stored user/assistant messages the cap left out.
     *
     * Counted rather than inferred from the difference between two totals,
     * because a third number — messages dropped for their role — is also part
     * of that difference and means something else entirely.
     */
    omittedByBudgetCount: number;
    /** Stored messages whose role the seed does not carry. */
    excludedByRoleCount: number;
    /** The estimate the caller prices, from the shared estimator. */
    estimatedTokens: number;
};

const shorten = (text: string) => {
    const points = [...text];
    return points.length > CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT
        ? {
              text: points
                  .slice(0, CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT)
                  .join(""),
              shortened: true,
          }
        : { text, shortened: false };
};

/**
 * The empty plan.
 *
 * Returned when there is nothing to seed *and* when the source is unreadable —
 * deleted, locked, or not the caller's. The caller does not branch on why: a
 * seed that must not be built and a seed with nothing in it both produce no
 * block, and giving them two shapes would invite one of them to be handled and
 * the other forgotten.
 */
export const emptyContinuationSeedPlan = (
    sourceMessageCount = 0
): ContinuationSeedPlan => ({
    seedVersion: CONTINUATION_SEED_VERSION,
    turns: [],
    fromOrdinal: 0,
    toOrdinal: 0,
    sourceMessageCount,
    truncatedCount: 0,
    omittedByBudgetCount: 0,
    excludedByRoleCount: 0,
    estimatedTokens: 0,
});

export type ContinuationSeedInput = {
    /** Stored messages of one snapshot, in any order; sorted here. */
    messages: readonly ContinuationSourceMessage[];
    /** Total stored messages in the snapshot, which may exceed `messages`. */
    sourceMessageCount?: number;
    tokenBudget?: number;
};

/**
 * Builds the plan.
 *
 * The window is taken from the newest end and grown backwards while whole
 * turns fit, then reversed so the model reads the exchange in the order it
 * happened. Growing forwards from the oldest turn would have produced the
 * beginning of a conversation the user has already moved past, which is the
 * opposite of what "continue this" means.
 */
export function planContinuationSeed(
    input: ContinuationSeedInput
): ContinuationSeedPlan {
    const budget = input.tokenBudget ?? CONTINUATION_SEED_TOKEN_BUDGET;
    const ordered = [...input.messages].sort((left, right) =>
        left.ordinal === right.ordinal ? 0 : left.ordinal < right.ordinal ? -1 : 1
    );
    const sourceMessageCount = input.sourceMessageCount ?? ordered.length;

    const eligible = ordered.filter((message) =>
        isContinuationSeedRole(message.role)
    );
    const excludedByRoleCount = ordered.length - eligible.length;

    if (budget <= 0 || eligible.length === 0) {
        return {
            ...emptyContinuationSeedPlan(sourceMessageCount),
            omittedByBudgetCount: eligible.length,
            excludedByRoleCount,
        };
    }

    const selected: ContinuationSeedTurn[] = [];
    let spent = 0;
    for (let index = eligible.length - 1; index >= 0; index -= 1) {
        const message = eligible[index]!;
        const { text, shortened } = shorten(message.content);
        // A blank turn is dropped rather than seeded: it costs a line and a
        // role label and says nothing, and it would still be counted in the
        // "N messages used" disclosure.
        if (text.trim().length === 0) continue;
        const cost = estimateTextTokens(text);
        if (spent + cost > budget) break;
        spent += cost;
        selected.push({
            role: message.role as ContinuationSeedRole,
            ordinal: message.ordinal,
            text,
            shortened: shortened || message.truncated,
        });
    }
    selected.reverse();

    if (selected.length === 0) {
        return {
            ...emptyContinuationSeedPlan(sourceMessageCount),
            omittedByBudgetCount: eligible.length,
            excludedByRoleCount,
        };
    }

    return {
        seedVersion: CONTINUATION_SEED_VERSION,
        turns: selected,
        fromOrdinal: selected[0]!.ordinal,
        toOrdinal: selected[selected.length - 1]!.ordinal,
        sourceMessageCount,
        truncatedCount: selected.filter((turn) => turn.shortened).length,
        omittedByBudgetCount: eligible.length - selected.length,
        excludedByRoleCount,
        estimatedTokens: spent,
    };
}
