/**
 * When a wave is due, and whether the scheduler may start it.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.
 *
 * Pure, so the two rules worth arguing about -- what "due" means, and what a
 * scheduler is allowed to do without a person -- can be read and tested without
 * a clock or a database.
 */

import { WAVE_KINDS, type WaveKind } from "@/lib/emailCampaignCore";

export const TRIGGER_MODES = [
    "manual",
    "auto_draft",
    "approved_schedule",
] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];

/**
 * Why the scheduler will not start a wave it found.
 *
 * Separate from `CampaignRunRefusal`, which answers "may this campaign send at
 * all". These are refusals about *automation*: the campaign might be perfectly
 * sendable by a person right now and still not be the scheduler's to start.
 */
export type ScheduleRefusal =
    | "not_scheduled"
    | "not_due"
    | "manual_trigger_mode"
    | "already_started";

export type ScheduleRefusalDetail = {
    refusal: ScheduleRefusal;
    message: string;
};

export type ScheduledWaveState = {
    kind: string;
    status: string;
    scheduledAt: Date | null;
    /** Set once the wave has an EmailEvent, which means it has begun. */
    eventId: string | null;
    triggerMode: string;
};

/**
 * Whether the scheduler may start this wave now.
 *
 * `null` means it may. The campaign's own state is *not* judged here -- that is
 * `campaignSendRefusal`'s question, and the caller asks it too. Two checks
 * rather than one because they answer to different people: this one says the
 * automation was asked for, that one says the words were approved.
 */
export const scheduleRefusal = (
    wave: ScheduledWaveState,
    now: Date
): ScheduleRefusalDetail | null => {
    if (wave.triggerMode !== "approved_schedule") {
        // A campaign left on `manual` is one somebody intends to watch as it
        // goes out. Starting it for them because a time happened to be set
        // would take that decision away silently.
        return {
            refusal: "manual_trigger_mode",
            message: `This campaign's trigger mode is ${wave.triggerMode}; only approved_schedule campaigns are started automatically.`,
        };
    }
    if (!wave.scheduledAt) {
        return {
            refusal: "not_scheduled",
            message: "This wave has no scheduled time, so it is started by hand.",
        };
    }
    if (wave.scheduledAt.getTime() > now.getTime()) {
        return {
            refusal: "not_due",
            message: `Due at ${wave.scheduledAt.toISOString()}, which is still ahead.`,
        };
    }
    if (wave.eventId || wave.status !== "pending") {
        // Not an error, and deliberately not silence either: a scheduler that
        // skipped started waves without saying so would look identical to one
        // that had stopped finding them.
        return {
            refusal: "already_started",
            message: `This wave is ${wave.status} and has already begun.`,
        };
    }
    return null;
};

/**
 * The order waves are sent in, for validating a schedule.
 *
 * A reminder before its notice is not a scheduling mistake to be sorted out at
 * send time -- it is a sequence that cannot be repaired afterwards, because the
 * reminder recomputes its audience from the people the notice already reached
 * (.github/audits/model-lifecycle-email-2026-08-22.md §12.3), and there are
 * none.
 */
export const WAVE_ORDER: readonly WaveKind[] = WAVE_KINDS;

export type WaveSchedule = { kind: WaveKind; scheduledAt: Date | null };

export type SchedulePlanProblem = {
    code: "out_of_order" | "duplicate_kind" | "in_the_past" | "after_effective_at";
    message: string;
};

/**
 * Everything wrong with a proposed set of wave times. Empty means it holds.
 *
 * Checked as a set rather than one wave at a time, because every problem here
 * is a relationship: earlier than the wave the sequence puts before it, later
 * than the date the campaign is about, a kind used twice.
 *
 * Sorted into `WAVE_ORDER` here rather than trusting the caller's order, and
 * that is the whole check. Compared in the order they arrive, a caller that
 * had sorted by time -- which is the natural way to list a schedule -- would
 * find the times already ascending and every ordering problem would pass. The
 * question is whether the *notice* comes before the *reminder*, not whether
 * the list is sorted.
 */
export const scheduleProblems = (input: {
    waves: readonly WaveSchedule[];
    now: Date;
    effectiveAt: Date | null;
}): SchedulePlanProblem[] => {
    const problems: SchedulePlanProblem[] = [];
    const seen = new Set<string>();
    let previous: { kind: WaveKind; at: Date } | null = null;

    const duplicates = new Set<string>();
    const counted = new Set<string>();
    for (const wave of input.waves) {
        if (counted.has(wave.kind)) duplicates.add(wave.kind);
        counted.add(wave.kind);
    }

    const ordered = [...input.waves].sort(
        (left, right) =>
            WAVE_ORDER.indexOf(left.kind) - WAVE_ORDER.indexOf(right.kind)
    );

    for (const wave of ordered) {
        if (seen.has(wave.kind)) continue;
        seen.add(wave.kind);
        if (duplicates.has(wave.kind)) {
            problems.push({
                code: "duplicate_kind",
                message: `Two ${wave.kind} waves are scheduled. Sequence numbers distinguish repeats; a second one here is an editing mistake.`,
            });
            continue;
        }
        if (!wave.scheduledAt) continue;

        if (wave.scheduledAt.getTime() < input.now.getTime()) {
            problems.push({
                code: "in_the_past",
                message: `The ${wave.kind} wave is scheduled for ${wave.scheduledAt.toISOString()}, which has passed. It would send the moment it is approved rather than when somebody intended.`,
            });
        }

        if (previous && wave.scheduledAt.getTime() < previous.at.getTime()) {
            problems.push({
                code: "out_of_order",
                message: `The ${wave.kind} wave is scheduled before the ${previous.kind} wave that precedes it. A reminder recomputes its audience from the people the notice reached, so sent first it reaches nobody.`,
            });
        }

        // The completion notice is the one that belongs after the date: it
        // reports a change that has happened.
        if (
            input.effectiveAt &&
            wave.kind !== "completion" &&
            wave.scheduledAt.getTime() > input.effectiveAt.getTime()
        ) {
            problems.push({
                code: "after_effective_at",
                message: `The ${wave.kind} wave is scheduled after the effective date. A warning that arrives once the change has happened is not a warning.`,
            });
        }

        previous = { kind: wave.kind, at: wave.scheduledAt };
    }

    return problems;
};

/**
 * Whether a mode may be stored.
 *
 * `auto_draft` means something drafted the campaign, not that anything sends
 * it: drafts are started by a person either way. It is distinct from `manual`
 * so a queue of machine-written drafts can be found and reviewed as a group.
 */
export const isTriggerMode = (value: string): value is TriggerMode =>
    (TRIGGER_MODES as readonly string[]).includes(value);
