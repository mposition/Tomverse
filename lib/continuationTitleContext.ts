/**
 * What an unnamed continuation is called when its source cannot name it, and
 * which state that source is in.
 *
 * Policy: docs/policy/external-conversation-continuation.md §3, §6.
 * Decisions: .github/audits/tomverse-product-idea-backlog.md, CONT-TITLE-01
 * "확정 구현 기준" (D2 and the time-zone rule).
 *
 * Pure and client-safe: the conversation list, message search, the import
 * page's continuation menu and both TXT exports all name a row through these
 * functions, so no two of them can disagree about it.
 *
 * ## The fallback name
 *
 * "{provider} · {date}" in the viewer's language. The provider is the
 * bridge's own column, which outlives the snapshot; the date is the day the
 * continuation was created -- not the day the source was deleted, and not the
 * last time it was used. Nothing here reads the source's words, and nothing
 * is stored: the name is built when it is shown.
 *
 * ## The date's time zone
 *
 * A calendar date needs a time zone, and the server has none of its own worth
 * using. The browser sends its zone as a display hint; the server validates
 * and canonicalises it, falls back to an explicit UTC, and computes the date
 * string itself. The page shows that string rather than recomputing it, so the
 * screen, the TXT filename and the TXT header cannot differ by a day because a
 * browser and a server disagree about a zone's rules. The hint decides
 * formatting only: never authorization, never which rows are read, never order.
 */

import { continuationDisplayTitle } from "@/lib/continuationDisplayTitle";

/** The request header carrying the browser's IANA time zone. */
export const DISPLAY_TIME_ZONE_HEADER = "X-Tomverse-Time-Zone";

const MAX_TIME_ZONE_HINT_LENGTH = 64;

/**
 * The time zone a date is shown in: the hint when it names a real zone,
 * otherwise UTC.
 *
 * `Intl.DateTimeFormat` accepts more than IANA names -- `"+09:00"` passes -- so
 * a resolved zone that is a fixed offset is refused too. The resolved name is
 * returned, which also canonicalises aliases and case (`"asia/seoul"` becomes
 * `"Asia/Seoul"`). `Intl.supportedValuesOf("timeZone")` is deliberately not the
 * allow-list: it omits valid aliases such as `Asia/Kolkata` and `US/Pacific`.
 */
export function effectiveDisplayTimeZone(hint: string | null | undefined): string {
    const candidate = hint?.trim();
    if (!candidate || candidate.length > MAX_TIME_ZONE_HINT_LENGTH) return "UTC";
    try {
        const resolved = new Intl.DateTimeFormat("en-US", {
            timeZone: candidate,
        }).resolvedOptions().timeZone;
        if (!resolved || /^[+-]/.test(resolved)) return "UTC";
        return resolved;
    } catch {
        return "UTC";
    }
}

/**
 * `YYYY-MM-DD` for `instant` in `timeZone`, in any locale.
 *
 * Built from parts with the Gregorian calendar and Latin digits forced, so an
 * Arabic or Thai default cannot change the digits or the calendar. Always
 * pass a zone that went through `effectiveDisplayTimeZone()`: omitting one
 * would silently use the server's own.
 */
export function displayDateInTimeZone(instant: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        calendar: "gregory",
        numberingSystem: "latn",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Which state an imported source is in, as far as naming its continuation
 * goes.
 *
 * Four states, never folded together: "the source was deleted" is the only
 * one the screen may label as deleted. A locked source and a source with an
 * empty title also leave the row without the source's name, but saying
 * "deleted" for them would be false.
 */
export type ContinuationSourceState = "available" | "locked" | "deleted" | "empty";

export function continuationSourceState(bridge: {
    externalConversationId: string | null;
    externalConversation: { title: string | null; password: string | null } | null;
}): ContinuationSourceState {
    // The foreign key is nulled by the database when the source is deleted.
    if (bridge.externalConversationId === null || !bridge.externalConversation) {
        return "deleted";
    }
    if (bridge.externalConversation.password !== null) return "locked";
    if (!bridge.externalConversation.title?.trim()) return "empty";
    return "available";
}

/**
 * The fallback name, from its translated template (`{provider}`, `{date}`).
 *
 * The template comes from the caller's locale file; the provider label and
 * the date are already resolved. Kept this small so the client and the TXT
 * export fill the same placeholders the same way.
 */
export function continuationFallbackTitle({
    template,
    providerLabel,
    date,
}: {
    template: string;
    providerLabel: string;
    date: string;
}): string {
    return template.replaceAll("{provider}", providerLabel).replaceAll("{date}", date);
}

/**
 * The bridge columns a route reads to name a continuation: the source's title
 * and password (the password only decides; it is never emitted), whether the
 * source still exists, the provider and the creation time. Nothing else --
 * the digest, the seed window and the import time answer questions no list
 * asks (docs/policy/external-conversation-continuation.md §3, §12).
 */
export const CONTINUATION_NAMING_BRIDGE_SELECT = {
    provider: true,
    createdAt: true,
    externalConversationId: true,
    externalConversation: { select: { title: true, password: true } },
} as const;

export type ContinuationNamingBridge = {
    provider: string;
    createdAt: Date;
    externalConversationId: string | null;
    externalConversation: { title: string | null; password: string | null } | null;
};

/** What a response carries so the page can name a row. */
export type ContinuationRowNaming = {
    /** The source's title, withheld unless the source is readable. */
    sourceTitle: string | null;
    sourceProvider: string | null;
    sourceState: ContinuationSourceState | null;
    /** `YYYY-MM-DD` in the effective display zone; the fallback name's date. */
    fallbackTitleDate: string | null;
};

const NO_CONTINUATION_NAMING: ContinuationRowNaming = {
    sourceTitle: null,
    sourceProvider: null,
    sourceState: null,
    fallbackTitleDate: null,
};

export function continuationRowNaming(
    bridge: ContinuationNamingBridge | null | undefined,
    timeZone: string
): ContinuationRowNaming {
    if (!bridge) return NO_CONTINUATION_NAMING;
    const sourceState = continuationSourceState(bridge);
    return {
        sourceTitle:
            sourceState === "available"
                ? (bridge.externalConversation?.title ?? null)
                : null,
        sourceProvider: bridge.provider,
        sourceState,
        fallbackTitleDate: displayDateInTimeZone(bridge.createdAt, timeZone),
    };
}

/**
 * A row's name as shown, given what the response carried and the viewer's
 * translated copy.
 *
 * The stored title wins unless it is the continuation writer's placeholder
 * (lib/continuationDisplayTitle.ts). Then the source's own name; then the
 * dated fallback; and only for a row that somehow has neither provider nor
 * date, the plain untitled copy.
 */
export function continuationRowTitle(
    row: {
        storedTitle: string;
        isContinuation: boolean;
    } & Partial<ContinuationRowNaming>,
    copy: {
        fallbackTemplate: string;
        untitled: string;
        providerLabel: (provider: string) => string;
    }
): string {
    return continuationDisplayTitle({
        storedTitle: row.storedTitle,
        isContinuation: row.isContinuation,
        sourceTitle: row.sourceTitle,
        fallback:
            row.sourceProvider && row.fallbackTitleDate
                ? continuationFallbackTitle({
                      template: copy.fallbackTemplate,
                      providerLabel: copy.providerLabel(row.sourceProvider),
                      date: row.fallbackTitleDate,
                  })
                : copy.untitled,
    });
}

/**
 * A conversation's title as the TXT exports write it, and the header line
 * that says which zone its date was read in.
 *
 * The same `continuationRowTitle()` the page uses, fed the same naming
 * columns, so the filename and the file's `Conversation:` line carry the date
 * the list shows. The zone line is written only when that dated fallback is
 * the title: a stored or source title has no date in it to explain.
 */
export function continuationExportTitle({
    storedTitle,
    bridge,
    timeZone,
    copy,
}: {
    storedTitle: string;
    bridge: ContinuationNamingBridge | null | undefined;
    timeZone: string;
    copy: {
        fallbackTemplate: string;
        untitled: string;
        providerLabel: (provider: string) => string;
    };
}): { title: string; headerLines: string[] } {
    const naming = continuationRowNaming(bridge, timeZone);
    const isContinuation = Boolean(bridge);
    const title = continuationRowTitle(
        { storedTitle, isContinuation, ...naming },
        copy
    );
    const datedFallback =
        isContinuation &&
        storedTitle !== title &&
        !naming.sourceTitle?.trim() &&
        naming.fallbackTitleDate !== null;
    return {
        title,
        headerLines: datedFallback ? [`Title date timezone: ${timeZone}`] : [],
    };
}

/**
 * The browser's own zone as the request header, or nothing where the runtime
 * cannot say. For `fetch` calls whose response names conversations.
 */
export function displayTimeZoneHeaders(): Record<string, string> {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return zone ? { [DISPLAY_TIME_ZONE_HEADER]: zone } : {};
    } catch {
        return {};
    }
}
