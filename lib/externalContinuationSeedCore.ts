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
 * the next turn does not fit. An already oversized boundary turn may still
 * contribute its complete closing paragraphs. Every shortened turn is counted.
 *
 * Pure: no database, no clock, no provider. The caller supplies rows and gets
 * a plan.
 */

import { estimateTextTokens } from "@/lib/chatTokenEstimate";
import { decodePassages, encodePassages, type Passage } from "@/lib/continuationPassages";

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
export const CONTINUATION_SEED_VERSION = "ext-seed-v2";

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
    /** UTF-16 coordinates in the authorised stored message, never in an excerpt. */
    ranges?: SourceRange[];
    selectedRanges?: SourceRange[];
    recentRanges?: SourceRange[];
};

export type SourceRange = { start: number; end: number };

export type ContinuationSeedPlan = {
    seedVersion: typeof CONTINUATION_SEED_VERSION | "ext-seed-v3-selected-recent";
    turns: ContinuationSeedTurn[];
    /** Ordinal window actually used. Both 0 when nothing was selected. */
    fromOrdinal: number;
    toOrdinal: number;
    /** How many stored messages the source snapshot has in total. */
    sourceMessageCount: number;
    /** Selected turns whose text is not complete. */
    truncatedCount: number;
    /**
     * Stored user/assistant messages **the cap** left out: eligible, carrying
     * text, and still not selected.
     *
     * Counted rather than inferred from the difference between two totals,
     * because the other reasons a stored message is absent — its role, and
     * having no text to carry — are also part of that difference and each mean
     * something else entirely. The seed header turns this number into a
     * sentence about the context budget (`lib/externalContinuationSeedPrompt.ts`),
     * so a message the budget never had a say about must not be in it.
     */
    omittedByBudgetCount: number;
    /** Stored messages whose role the seed does not carry. */
    excludedByRoleCount: number;
    /**
     * Eligible messages whose text is blank once the per-message cap is
     * applied. Dropped by the rule, never by the budget: a turn with nothing
     * in it would cost a line and a role label and say nothing.
     */
    blankSkippedCount: number;
    /** The estimate the caller prices, from the shared estimator. */
    estimatedTokens: number;
};

// Reserve room for the given opening and find the longest ending that fits.
// Both the omission marker and every retained character count toward the caps.
function fittingSuffix(points: string[], opening = "", budget = CONTINUATION_SEED_TOKEN_BUDGET) {
    const room = CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT - Array.from(opening).length;
    let low = Math.max(0, points.length - room);
    let high = points.length;
    const candidate = points.slice(low).join("");
    if (estimateTextTokens(opening + candidate) <= budget) return candidate;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (estimateTextTokens(opening + points.slice(middle).join("")) > budget) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return points.slice(low).join("");
}

export function excerptContinuationMessage(text: string) {
    const limit = CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT;
    if (text.length <= limit && estimateTextTokens(text) <= CONTINUATION_SEED_TOKEN_BUDGET) {
        return { text, shortened: false, ranges: [{ start: 0, end: text.length }] };
    }

    // Export padding should not displace the last substantive paragraph.
    const end = text.trimEnd();
    const points = Array.from(end.slice(-2 * limit)).slice(-limit);
    const fullTail = fittingSuffix(points);
    const tailRange = (tail: string) => [{ start: end.length - tail.length, end: end.length }];
    if (fullTail === end) return { text: fullTail, shortened: fullTail !== text, ranges: tailRange(fullTail) };

    // Keep a little opening context when it only displaces part of the paragraph
    // already cut by the suffix. A complete closing paragraph has first claim.
    const lineBreak = /[\r\n\u2028\u2029]/u;
    if (lineBreak.test(end.charAt(end.length - fullTail.length - 1))) {
        return { text: fullTail, shortened: true, ranges: tailRange(fullTail) };
    }
    const openingLength = Math.floor(limit / 8);
    const head = Array.from(end.slice(0, 2 * openingLength)).slice(0, openingLength).join("");
    if (!head.trim()) return { text: fullTail, shortened: true, ranges: tailRange(fullTail) };
    const opening = head + " […] ";
    const tail = fittingSuffix(points, opening);
    const firstBreak = fullTail.search(lineBreak);
    const dropsWholeParagraph = firstBreak >= 0 && fullTail.length - tail.length > firstBreak + 1;
    return { text: dropsWholeParagraph ? fullTail : opening + tail, shortened: true,
        ranges: dropsWholeParagraph ? tailRange(fullTail) : [{ start: 0, end: head.length }, ...tailRange(tail)] };
}

// A short follow-up must not displace an entire earlier oversized turn when
// its complete closing paragraphs still fit in the remaining window.
function closingParagraphs(text: string, remaining: number): string {
    if (remaining <= 0) return "";
    const end = text.trimEnd();
    const limit = CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT;
    const points = Array.from(end.slice(-2 * limit)).slice(-limit);
    const tail = fittingSuffix(points, "", remaining);
    const start = end.length - tail.length;
    if (start === 0 || /[\r\n\u2028\u2029]/u.test(end.charAt(start - 1))) return tail;
    const boundary = tail.search(/[\r\n\u2028\u2029]/u);
    return boundary < 0 ? "" : tail.slice(boundary + 1).trimStart();
}

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
    blankSkippedCount: 0,
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

    // Every nonblank message retains its last substantive character, so blanks
    // can be counted before building excerpts for the newest turns we need.
    const candidates = eligible.filter((message) => /\S/u.test(message.content));
    const blankSkippedCount = eligible.length - candidates.length;

    if (budget <= 0 || candidates.length === 0) {
        return {
            ...emptyContinuationSeedPlan(sourceMessageCount),
            omittedByBudgetCount: candidates.length,
            excludedByRoleCount,
            blankSkippedCount,
        };
    }

    const selected: ContinuationSeedTurn[] = [];
    let spent = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const message = candidates[index]!;
        const excerpt = excerptContinuationMessage(message.content);
        let text = excerpt.text;
        let cost = estimateTextTokens(text);
        const atBoundary = spent + cost > budget;
        if (atBoundary) {
            if (!excerpt.shortened) break;
            text = closingParagraphs(message.content, budget - spent);
            if (!text.trim()) break;
            cost = estimateTextTokens(text);
        }
        spent += cost;
        selected.push({
            role: message.role as ContinuationSeedRole,
            ordinal: message.ordinal,
            text,
            shortened: excerpt.shortened || message.truncated,
            ranges: atBoundary
                ? [{ start: message.content.trimEnd().length - text.length, end: message.content.trimEnd().length }]
                : excerpt.ranges,
        });
        if (atBoundary) break;
    }
    selected.reverse();

    if (selected.length === 0) {
        return {
            ...emptyContinuationSeedPlan(sourceMessageCount),
            omittedByBudgetCount: candidates.length,
            excludedByRoleCount,
            blankSkippedCount,
        };
    }

    return {
        seedVersion: CONTINUATION_SEED_VERSION,
        turns: selected,
        fromOrdinal: selected[0]!.ordinal,
        toOrdinal: selected[selected.length - 1]!.ordinal,
        sourceMessageCount,
        truncatedCount: selected.filter((turn) => turn.shortened).length,
        omittedByBudgetCount: candidates.length - selected.length,
        excludedByRoleCount,
        blankSkippedCount,
        estimatedTokens: spent,
    };
}

const mergeRanges = (ranges: readonly SourceRange[]): SourceRange[] => {
    const result: SourceRange[] = [];
    for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
        const last = result.at(-1);
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else result.push({ ...range });
    }
    return result;
};

const renderRanges = (text: string, ranges: readonly SourceRange[]) =>
    ranges.map(range => text.slice(range.start, range.end)).join(" […] ");

/** Selection has first claim; the unchanged v2 recent window fills the same body budget. */
export function planSelectedContinuationSeed(input: ContinuationSeedInput & {
    selectedMessages: readonly ContinuationSourceMessage[];
    passages: readonly Passage[];
}): ContinuationSeedPlan {
    const empty = () => ({ ...emptyContinuationSeedPlan(input.sourceMessageCount),
        seedVersion: "ext-seed-v3-selected-recent" as const });
    // Revalidate even for non-HTTP callers. An explicit invalid selection never becomes Auto.
    const passages = decodePassages(encodePassages(input.passages));
    if (!passages?.length) return empty();
    const budget = Math.min(input.tokenBudget ?? CONTINUATION_SEED_TOKEN_BUDGET, CONTINUATION_SEED_TOKEN_BUDGET);
    const rows = new Map([...input.messages, ...input.selectedMessages].map(row => [row.ordinal, row]));
    const turns = new Map<number, ContinuationSeedTurn>();
    for (const passage of passages) {
        const row = rows.get(passage.ordinal);
        if (!row || !isContinuationSeedRole(row.role) || passage.end > row.content.length) return empty();
        let { start, end } = passage;
        if (/[\uDC00-\uDFFF]/u.test(row.content.charAt(start))) start++;
        if (/[\uD800-\uDBFF]/u.test(row.content.charAt(end - 1))) end--;
        if (end <= start || !row.content.slice(start, end).trim()) return empty();
        const ranges = [{ start, end }];
        turns.set(row.ordinal, { role: row.role, ordinal: row.ordinal, text: renderRanges(row.content, ranges),
            shortened: row.truncated || start > 0 || end < row.content.length, ranges, selectedRanges: ranges, recentRanges: [] });
    }
    let spent = [...turns.values()].reduce((sum, turn) => sum + estimateTextTokens(turn.text), 0);
    if (spent > budget) return empty();
    const recent = planContinuationSeed(input);
    for (const turn of [...recent.turns].reverse()) {
        const row = rows.get(turn.ordinal)!;
        const previous = turns.get(turn.ordinal);
        const selected = previous?.selectedRanges ?? [];
        const previousCost = estimateTextTokens(previous?.text ?? "");
        const fullRanges = turn.ranges ?? [];
        const make = (ranges: SourceRange[]) => {
            const merged = mergeRanges([...selected, ...ranges]);
            const text = renderRanges(row.content, merged);
            return { merged, text, cost: estimateTextTokens(text) };
        };
        let kept = fullRanges;
        let next = make(kept);
        const fits = (value: ReturnType<typeof make>) => Array.from(value.text).length <= CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT &&
            spent - previousCost + value.cost <= budget;
        if (!fits(next)) {
            // Trim only the recent contribution, from its oldest edge. Selection coordinates stay exact.
            const suffix = (count: number) => {
                let room = count;
                const result: SourceRange[] = [];
                for (const range of [...fullRanges].reverse()) {
                    const points = Array.from(row.content.slice(range.start, range.end));
                    const tail = points.slice(Math.max(0, points.length - room)).join("");
                    if (tail) result.unshift({ start: range.end - tail.length, end: range.end });
                    room -= Array.from(tail).length;
                    if (room <= 0) break;
                }
                return result;
            };
            let low = 0, high = fullRanges.reduce((sum, range) => sum + Array.from(row.content.slice(range.start, range.end)).length, 0);
            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                if (fits(make(suffix(middle)))) low = middle;
                else high = middle - 1;
            }
            kept = suffix(low);
            next = make(kept);
        }
        if (!kept.length || !next.text.trim() || !fits(next)) continue;
        spent = spent - previousCost + next.cost;
        turns.set(row.ordinal, { role: turn.role, ordinal: row.ordinal, text: next.text,
            ranges: next.merged, selectedRanges: selected, recentRanges: kept,
            shortened: row.truncated || next.merged.length !== 1 || next.merged[0].start !== 0 || next.merged[0].end !== row.content.length });
    }
    const ordered = [...turns.values()].sort((a, b) => a.ordinal - b.ordinal);
    const eligible = input.messages.filter(row => isContinuationSeedRole(row.role) && row.content.trim());
    return { ...recent, seedVersion: "ext-seed-v3-selected-recent", turns: ordered,
        fromOrdinal: ordered[0]?.ordinal ?? 0, toOrdinal: ordered.at(-1)?.ordinal ?? 0,
        sourceMessageCount: input.sourceMessageCount ?? rows.size,
        estimatedTokens: spent, truncatedCount: ordered.filter(turn => turn.shortened).length,
        omittedByBudgetCount: eligible.filter(row => !turns.has(row.ordinal)).length };
}
