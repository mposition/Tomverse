"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    formatBytes,
    interpolate,
    primaryButtonClass,
    providerLabel,
    secondaryButtonClass,
} from "@/components/imports/importFormatting";
import { EXTERNAL_IMPORT_STORAGE_LIMITS } from "@/lib/externalImportLimits";
import {
    filteredRows,
    isRowSelectable,
    matchesConversationFilter,
    providerGuidanceMismatch,
    projectQuota,
    selectedHiddenCount,
    selectionTotals,
    type CapacityRemaining,
    type ConversationFilter,
    type ConversationSelectionRow,
    type ExternalImportWizardState,
    type ParseWarningTotals,
} from "@/lib/externalImportWizard";

/**
 * Step 3 — choosing which conversations to import.
 *
 * Two things make this screen harder than a checkbox list:
 *
 *   * an export can hold 2,000 conversations, so the list is windowed. Only
 *     the rows near the viewport are mounted, which means the DOM is *not* a
 *     record of what is selected — the state machine is. Every bulk action
 *     here dispatches against the filtered dataset, never against the mounted
 *     rows, and the "N of your M selected are hidden by this filter" line
 *     exists so a narrowed view never reads as a shrunken selection;
 *   * truncation approval is per conversation (§5.4). There is deliberately
 *     no switch that approves them all: each shortened conversation carries
 *     its own consent checkbox, its own impact line, and leaves the selection
 *     the moment consent is withdrawn.
 *
 * Focus survives scrolling because the row that currently holds focus is
 * pinned into the render window even after it scrolls out of view.
 */

const ROW_HEIGHT: Record<ConversationSelectionRow["eligibility"]["kind"], number> =
    {
        importable: 72,
        requires_truncation_approval: 116,
        blocked_oversized_message: 104,
    };

const VIEWPORT_HEIGHT = 420;
const OVERSCAN_PX = 240;

type RowLayout = { row: ConversationSelectionRow; top: number; height: number };

function useRowLayout(rows: readonly ConversationSelectionRow[]) {
    return useMemo(() => {
        const layout: RowLayout[] = [];
        let top = 0;
        for (const row of rows) {
            const height = ROW_HEIGHT[row.eligibility.kind];
            layout.push({ row, top, height });
            top += height;
        }
        return { layout, totalHeight: top };
    }, [rows]);
}

export function ConversationSelectionStep({
    state,
    capacityRemaining,
    busy,
    onToggleConversation,
    onSetTruncationApproval,
    onSelectAll,
    onClearAll,
    onSetFilter,
    onContinue,
    onBack,
}: {
    state: ExternalImportWizardState;
    capacityRemaining: CapacityRemaining | null;
    busy: boolean;
    onToggleConversation: (id: string) => void;
    onSetTruncationApproval: (id: string, approved: boolean) => void;
    onSelectAll: () => void;
    onClearAll: () => void;
    onSetFilter: (filter: Partial<ConversationFilter>) => void;
    onContinue: () => void;
    onBack: () => void;
}) {
    const { t } = useLanguage();
    const [scrollTop, setScrollTop] = useState(0);
    const [focusedId, setFocusedId] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    const visibleRows = useMemo(() => filteredRows(state), [state]);
    const { layout, totalHeight } = useRowLayout(visibleRows);
    const totals = useMemo(() => selectionTotals(state), [state]);
    const hidden = useMemo(() => selectedHiddenCount(state), [state]);
    const quota = useMemo(
        () => projectQuota(state, capacityRemaining),
        [state, capacityRemaining]
    );
    const mismatch = providerGuidanceMismatch(state);

    const windowed = useMemo(() => {
        const from = scrollTop - OVERSCAN_PX;
        const to = scrollTop + VIEWPORT_HEIGHT + OVERSCAN_PX;
        const inWindow = layout.filter(
            (entry) => entry.top + entry.height >= from && entry.top <= to
        );
        if (!focusedId) return inWindow;
        if (inWindow.some((entry) => entry.row.id === focusedId)) return inWindow;
        // Keeping the focused row mounted is what stops a scroll from
        // dropping keyboard focus to the document body.
        const focused = layout.find((entry) => entry.row.id === focusedId);
        return focused ? [...inWindow, focused] : inWindow;
    }, [layout, scrollTop, focusedId]);

    const handleScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            setScrollTop(event.currentTarget.scrollTop);
        },
        []
    );

    const filterActive =
        state.filter.query.trim().length > 0 ||
        state.filter.from !== null ||
        state.filter.to !== null;

    return (
        <div data-testid="external-import-selection">
            <h2 className="text-base font-bold">
                {t("externalImport.previewTitle")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
                {interpolate(t("externalImport.previewProvider"), {
                    provider: providerLabel(state.detectedProvider ?? ""),
                })}
            </p>

            {mismatch && (
                <p
                    className="mt-2 flex items-start gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm leading-6 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300"
                    data-testid="external-import-provider-mismatch"
                >
                    <Info className="mt-1 h-4 w-4 shrink-0" />
                    {interpolate(t("externalImport.providerMismatchNotice"), {
                        detected: providerLabel(mismatch.detected),
                    })}
                </p>
            )}

            <ParseWarnings warnings={state.warnings} />

            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <input
                    type="search"
                    value={state.filter.query}
                    aria-label={t("externalImport.searchPlaceholder")}
                    placeholder={t("externalImport.searchPlaceholder")}
                    data-testid="external-import-search"
                    onChange={(event) =>
                        onSetFilter({ query: event.target.value })
                    }
                    className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                />
                <input
                    type="date"
                    value={state.filter.from ?? ""}
                    aria-label={t("externalImport.filterFrom")}
                    data-testid="external-import-filter-from"
                    onChange={(event) =>
                        onSetFilter({ from: event.target.value || null })
                    }
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                />
                <input
                    type="date"
                    value={state.filter.to ?? ""}
                    aria-label={t("externalImport.filterTo")}
                    data-testid="external-import-filter-to"
                    onChange={(event) =>
                        onSetFilter({ to: event.target.value || null })
                    }
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                    data-testid="external-import-select-all"
                    onClick={onSelectAll}
                >
                    {t("externalImport.selectAllNormal")}
                </button>
                <button
                    type="button"
                    className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                    data-testid="external-import-clear-all"
                    onClick={onClearAll}
                >
                    {t("externalImport.clearAllNormal")}
                </button>
                {filterActive && (
                    <button
                        type="button"
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-zinc-500 underline"
                        data-testid="external-import-filter-clear"
                        onClick={() =>
                            onSetFilter({ query: "", from: null, to: null })
                        }
                    >
                        {t("externalImport.filterClear")}
                    </button>
                )}
            </div>

            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                <p
                    className="text-sm leading-6 text-zinc-600 dark:text-zinc-300"
                    data-testid="external-import-selection-summary"
                >
                    {interpolate(t("externalImport.selectionSummary"), {
                        selected: totals.conversations,
                        size: formatBytes(totals.bytes),
                    })}
                </p>
                {quota && (
                    <p
                        className="text-sm leading-6 text-zinc-500"
                        data-testid="external-import-remaining-space"
                    >
                        {interpolate(t("externalImport.remainingSpace"), {
                            remaining: formatBytes(
                                quota.remaining.normalizedTextBytes
                            ),
                        })}
                    </p>
                )}
            </div>

            {hidden > 0 && (
                <p
                    className="mt-1 text-sm leading-6 text-zinc-500"
                    role="status"
                    data-testid="external-import-hidden-selection"
                >
                    {interpolate(t("externalImport.selectionHiddenNotice"), {
                        selected: totals.conversations,
                        hidden,
                    })}
                </p>
            )}

            {quota?.exceeded && (
                <p
                    className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200"
                    data-testid="external-import-quota-warning"
                >
                    {t("externalImport.quotaExceededWarning")}
                </p>
            )}

            <div
                ref={listRef}
                onScroll={handleScroll}
                onFocusCapture={(event) => {
                    const id = (event.target as HTMLElement)
                        .closest("[data-conversation-id]")
                        ?.getAttribute("data-conversation-id");
                    if (id) setFocusedId(id);
                }}
                style={{ height: VIEWPORT_HEIGHT }}
                className="mt-3 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800"
                data-testid="external-import-conversation-list"
            >
                <ul
                    aria-label={t("externalImport.previewTitle")}
                    style={{ height: totalHeight, position: "relative" }}
                    className="m-0 list-none p-0"
                >
                    {windowed.map(({ row, top, height }) => (
                        <ConversationRow
                            key={row.id}
                            row={row}
                            top={top}
                            height={height}
                            position={
                                visibleRows.findIndex(
                                    (candidate) => candidate.id === row.id
                                ) + 1
                            }
                            total={visibleRows.length}
                            selected={state.selectedIds.has(row.id)}
                            truncationApproved={state.truncationApprovals.has(
                                row.id
                            )}
                            selectable={isRowSelectable(
                                row,
                                state.truncationApprovals
                            )}
                            outsideFilter={
                                !matchesConversationFilter(row, state.filter)
                            }
                            onToggle={() => onToggleConversation(row.id)}
                            onSetTruncationApproval={(approved) =>
                                onSetTruncationApproval(row.id, approved)
                            }
                        />
                    ))}
                </ul>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
                <button
                    type="button"
                    className={primaryButtonClass}
                    data-testid="external-import-continue-to-review"
                    disabled={totals.conversations === 0 || quota?.exceeded || busy}
                    onClick={onContinue}
                >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("externalImport.continueToReview")}
                </button>
                <button
                    type="button"
                    className={secondaryButtonClass}
                    data-testid="external-import-back-step"
                    onClick={onBack}
                >
                    {t("externalImport.back")}
                </button>
            </div>
        </div>
    );
}

/**
 * What normalization left behind, stated once above the list (§5.6): skipped
 * system/tool messages, skipped non-text parts, alternate branches, and the
 * two aggregate eligibility counts. The truncation block explains the policy
 * and deliberately carries no control — consent is given per row.
 */
function ParseWarnings({ warnings }: { warnings: ParseWarningTotals }) {
    const { t } = useLanguage();
    const lines: string[] = [];
    if (warnings.skippedNonConversationMessages > 0) {
        lines.push(
            interpolate(t("externalImport.warningSkippedMessages"), {
                count: warnings.skippedNonConversationMessages,
            })
        );
    }
    if (warnings.skippedNonTextParts > 0) {
        lines.push(
            interpolate(t("externalImport.warningSkippedParts"), {
                count: warnings.skippedNonTextParts,
            })
        );
    }
    if (warnings.additionalBranches > 0) {
        lines.push(
            interpolate(t("externalImport.warningBranches"), {
                count: warnings.additionalBranches,
            })
        );
    }
    if (warnings.skippedNestedArchives > 0) {
        // Its own line rather than a share of "unsupported file type": the
        // user attached these deliberately and would otherwise have no way to
        // tell why they are absent (§5.2).
        lines.push(
            interpolate(t("externalImport.warningNestedArchives"), {
                count: warnings.skippedNestedArchives,
            })
        );
    }
    if (warnings.missingAttachments > 0) {
        // Separate from every other skip: this is what the export did not
        // contain, not what we chose to leave out (A2 §4.1).
        lines.push(
            interpolate(t("externalImport.warningMissingAttachments"), {
                count: warnings.missingAttachments,
            })
        );
    }
    if (warnings.duplicatedBranchMessages > 0) {
        // Branches are imported whole, so a turn before the branch point is
        // stored in each branch and costs quota in each (A2 §2.2). Saying so
        // before the import is the difference between a design and a surprise.
        lines.push(
            interpolate(t("externalImport.warningBranchDuplicates"), {
                count: warnings.duplicatedBranchMessages,
            })
        );
    }
    if (warnings.skippedUnrecognizedAnswers > 0) {
        // A conversation whose answer is simply absent, with nothing said
        // about it, reads as a question the model never answered (A2 §5).
        lines.push(
            interpolate(t("externalImport.warningUnrecognizedAnswers"), {
                count: warnings.skippedUnrecognizedAnswers,
            })
        );
    }
    if (warnings.unassignedTurns > 0) {
        // The export named no conversation for these. Guessing one from
        // timing is forbidden (A2 §2), so the count is the whole disclosure.
        lines.push(
            interpolate(t("externalImport.warningUnassignedTurns"), {
                count: warnings.unassignedTurns,
            })
        );
    }

    return (
        <>
            {lines.length > 0 && (
                <div
                    className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/60"
                    data-testid="external-import-warnings"
                >
                    <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                        {t("externalImport.warningsTitle")}
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs leading-5 text-zinc-500">
                        {lines.map((line) => (
                            <li key={line}>{line}</li>
                        ))}
                    </ul>
                </div>
            )}

            {warnings.notImportable > 0 && (
                <p
                    className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200"
                    data-testid="external-import-not-importable"
                >
                    {interpolate(t("externalImport.notImportableExplain"), {
                        count: warnings.notImportable,
                    })}
                </p>
            )}

            {warnings.requiresTruncationApproval > 0 && (
                <div
                    className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/20"
                    data-testid="external-import-truncation-explain"
                >
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                        {t("externalImport.truncationTitle")}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-amber-800/90 dark:text-amber-200/90">
                        {interpolate(t("externalImport.truncationExplain"), {
                            conversations: warnings.requiresTruncationApproval,
                            limit: EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints.toLocaleString(),
                        })}
                    </p>
                </div>
            )}
        </>
    );
}

function ConversationRow({
    row,
    top,
    height,
    position,
    total,
    selected,
    truncationApproved,
    selectable,
    outsideFilter,
    onToggle,
    onSetTruncationApproval,
}: {
    row: ConversationSelectionRow;
    top: number;
    height: number;
    position: number;
    total: number;
    selected: boolean;
    truncationApproved: boolean;
    selectable: boolean;
    /** True only for the focus-pinned row that scrolled out of the filter. */
    outsideFilter: boolean;
    onToggle: () => void;
    onSetTruncationApproval: (approved: boolean) => void;
}) {
    const { t } = useLanguage();
    const eligibility = row.eligibility;
    return (
        <li
            data-conversation-id={row.id}
            data-testid="external-import-conversation-row"
            aria-posinset={outsideFilter ? undefined : position}
            aria-setsize={outsideFilter ? undefined : total}
            style={{
                position: "absolute",
                top,
                height,
                left: 0,
                right: 0,
                display: outsideFilter ? "none" : undefined,
            }}
            className="overflow-hidden border-b border-zinc-100 px-3 py-2 dark:border-zinc-900"
        >
            <label
                className={`flex items-start gap-2.5 ${
                    selectable ? "cursor-pointer" : "cursor-not-allowed"
                }`}
            >
                <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0"
                    checked={selected}
                    disabled={!selectable}
                    data-testid="external-import-conversation-toggle"
                    onChange={onToggle}
                />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {row.title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
                        {interpolate(t("externalImport.messagesCount"), {
                            count: row.messageCount,
                        })}
                        {" · "}
                        {formatBytes(row.estimatedStoredBytes)}
                        <span className="sr-only">
                            {" · "}
                            {interpolate(t("externalImport.rowPosition"), {
                                index: position,
                                total,
                            })}
                        </span>
                    </span>
                </span>
            </label>

            {eligibility.kind === "requires_truncation_approval" && (
                <div className="mt-1 pl-6.5">
                    <p
                        className="text-xs leading-5 text-amber-700 dark:text-amber-300"
                        data-testid="external-import-row-truncation-impact"
                    >
                        {interpolate(t("externalImport.rowTruncationImpact"), {
                            count: eligibility.truncatedMessageCount,
                        })}
                    </p>
                    <label className="mt-1 flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-200">
                        <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={truncationApproved}
                            data-testid="external-import-row-truncation-consent"
                            onChange={(event) =>
                                onSetTruncationApproval(event.target.checked)
                            }
                        />
                        {t("externalImport.rowTruncationConsent")}
                    </label>
                </div>
            )}

            {eligibility.kind === "blocked_oversized_message" && (
                <p
                    className="mt-1 flex items-start gap-1.5 pl-6.5 text-xs leading-5 text-amber-700 dark:text-amber-300"
                    data-testid="external-import-row-blocked-reason"
                >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {interpolate(t("externalImport.rowBlockedReason"), {
                        count: eligibility.oversizedMessageCount,
                    })}
                </p>
            )}
        </li>
    );
}
