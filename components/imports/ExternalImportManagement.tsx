"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
    AlertTriangle,
    Clock,
    Download,
    Loader2,
    Lock,
    Plus,
    Trash2,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    SourceDeletionNotice,
    type SourceDeletionImpactView,
} from "@/components/imports/SourceDeletionNotice";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import {
    formatBytes,
    interpolate,
    primaryButtonClass,
    providerLabel,
    secondaryButtonClass,
    sectionClass,
} from "@/components/imports/importFormatting";
import {
    groupConversationsByLineage,
    type LineageGroup,
} from "@/lib/externalConversationLineage";

/**
 * /settings/imports — the management screen.
 *
 * docs/policy/external-conversation-import-and-memory.md §5.5, §15, §21.
 *
 * This page owns everything that outlives one wizard run: storage usage, the
 * conversations already imported, the history of past runs, and the card for
 * anything still unfinished. The wizard itself lives at
 * /settings/imports/new, so leaving it with the browser's Back button lands
 * here — which is why this screen has to be able to say, truthfully, what the
 * abandoned run left behind.
 *
 * Three unfinished shapes, three different offers:
 *
 *   * sealed and still inside its TTL — resumable, so "Finish this import";
 *   * a partial upload that was never sealed — the server cannot know whether
 *     the rest was ever going to arrive, so only "Start over" and "Delete".
 *     Faking a resume by stashing the File or the parsed payload in
 *     local/sessionStorage is not an option: the archive stays on the device
 *     and out of persistent storage (§5.1);
 *   * expired — shown as expired rather than quietly dropped.
 *
 * Availability comes from the server: the capacity endpoint is the flag probe
 * (403 => no new imports), while the history list, delete and export stay
 * reachable so a rollback never strands imported data (§15).
 */

const IMPORT_STATUS_KEYS: Record<string, string> = {
    completed: "externalImport.statusCompleted",
    failed: "externalImport.statusFailed",
    cancelled: "externalImport.statusCancelled",
    staging: "externalImport.statusStaging",
    preview_ready: "externalImport.statusPreviewReady",
};

type Capacity = {
    limits: {
        maxNormalizedTextBytes: number;
        maxExternalConversations: number;
        maxExternalMessages: number;
    };
    usage: {
        normalizedTextBytes: number;
        externalConversations: number;
        externalMessages: number;
    };
    remaining: {
        normalizedTextBytes: number;
        externalConversations: number;
        externalMessages: number;
    };
};

type CapacityState =
    | { kind: "loading" }
    | { kind: "ready"; capacity: Capacity }
    | { kind: "disabled" }
    | { kind: "unauthenticated" }
    | { kind: "error" };

export type ImportHistoryRow = {
    id: string;
    provider: string;
    status: string;
    failureCode: string | null;
    conversationCount: number;
    messageCount: number;
    normalizedBytes: number;
    truncationCount: number;
    duplicateCount: number;
    createdAt: string;
    completedAt: string | null;
    expiresAt?: string | null;
    expired?: boolean;
    resumable?: boolean;
};

type HistoryState =
    | { kind: "loading" }
    | { kind: "ready"; imports: ImportHistoryRow[] }
    | { kind: "unauthenticated" }
    | { kind: "error" };

export type ViewerConversationRow = {
    id: string;
    provider: string;
    title: string;
    externalStableId: string;
    messageCount: number;
    contentBytes: number;
    importedAt: string;
    /** A password is set on this snapshot (§7) -- never the hash itself. */
    locked?: boolean;
};

/** Hidden covers 401/403: the viewer list is flag-gated, unlike history. */
type ConversationsState =
    | { kind: "loading" }
    | { kind: "ready"; rows: ViewerConversationRow[]; total: number }
    | { kind: "hidden" }
    | { kind: "error" };

const CONVERSATIONS_PAGE_SIZE = 50;

const UNFINISHED_STATUSES = new Set(["staging", "preview_ready"]);

export function ExternalImportManagement() {
    const { t } = useLanguage();
    const [capacityState, setCapacityState] = useState<CapacityState>({
        kind: "loading",
    });
    const [historyState, setHistoryState] = useState<HistoryState>({
        kind: "loading",
    });
    const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
    // Read when the delete is armed, not on every list render: the
    // confirmation needs the number, the listing does not (§13.1).
    const [memoryImpact, setMemoryImpact] =
        useState<SourceDeletionImpactView | null>(null);
    const [keepMemories, setKeepMemories] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [conversationsState, setConversationsState] =
        useState<ConversationsState>({ kind: "loading" });
    const [expandedLineages, setExpandedLineages] = useState<
        ReadonlySet<string>
    >(new Set());

    const loadCapacity = useCallback(async () => {
        try {
            const response = await fetch("/api/imports/external/capacity", {
                cache: "no-store",
            });
            if (response.status === 401) {
                setCapacityState({ kind: "unauthenticated" });
                return;
            }
            if (response.status === 403) {
                setCapacityState({ kind: "disabled" });
                return;
            }
            if (!response.ok) {
                setCapacityState({ kind: "error" });
                return;
            }
            const capacity = (await response.json()) as Capacity;
            setCapacityState({ kind: "ready", capacity });
        } catch {
            setCapacityState({ kind: "error" });
        }
    }, []);

    const loadHistory = useCallback(async () => {
        try {
            const response = await fetch("/api/imports/external", {
                cache: "no-store",
            });
            if (response.status === 401) {
                setHistoryState({ kind: "unauthenticated" });
                return;
            }
            if (!response.ok) {
                setHistoryState({ kind: "error" });
                return;
            }
            const body = (await response.json()) as {
                imports: ImportHistoryRow[];
            };
            setHistoryState({
                kind: "ready",
                imports: Array.isArray(body.imports) ? body.imports : [],
            });
        } catch {
            setHistoryState({ kind: "error" });
        }
    }, []);

    const loadConversations = useCallback(
        async ({ append = false }: { append?: boolean } = {}) => {
            const offset =
                append && conversationsState.kind === "ready"
                    ? conversationsState.rows.length
                    : 0;
            try {
                const response = await fetch(
                    `/api/external-conversations?offset=${offset}&limit=${CONVERSATIONS_PAGE_SIZE}`,
                    { cache: "no-store" }
                );
                if (response.status === 401 || response.status === 403) {
                    setConversationsState({ kind: "hidden" });
                    return;
                }
                if (!response.ok) {
                    setConversationsState({ kind: "error" });
                    return;
                }
                const body = (await response.json()) as {
                    total: number;
                    conversations: ViewerConversationRow[];
                };
                const nextRows = Array.isArray(body.conversations)
                    ? body.conversations
                    : [];
                setConversationsState((current) => ({
                    kind: "ready",
                    total: body.total,
                    rows:
                        append && current.kind === "ready"
                            ? [...current.rows, ...nextRows]
                            : nextRows,
                }));
            } catch {
                setConversationsState({ kind: "error" });
            }
        },
        [conversationsState]
    );

    useEffect(() => {
        queueMicrotask(() => {
            void loadCapacity();
            void loadHistory();
            void loadConversations();
        });
        // Mount-only: the reload paths (delete) call the loaders directly, and
        // loadConversations' identity changes with its state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const deleteImportRow = useCallback(
        async (importId: string) => {
            if (armedDeleteId !== importId) {
                setArmedDeleteId(importId);
                setMemoryImpact(null);
                setKeepMemories(false);
                try {
                    const preview = await fetch(
                        `/api/imports/external/${importId}?include=memoryImpact`,
                        { cache: "no-store" }
                    );
                    if (preview.ok) {
                        const body = (await preview.json()) as {
                            memoryImpact?: SourceDeletionImpactView;
                        };
                        setMemoryImpact(body.memoryImpact ?? null);
                    }
                } catch {
                    // No preview is not a reason to block the delete; the
                    // server still applies the §13.1 defaults.
                }
                return;
            }
            setDeletingId(importId);
            try {
                const response = await fetch(
                    `/api/imports/external/${importId}?derivedMemories=${
                        keepMemories ? "suspend" : "delete"
                    }`,
                    { method: "DELETE" }
                );
                if (response.ok) {
                    void loadCapacity();
                    void loadConversations();
                    await loadHistory();
                }
            } finally {
                setDeletingId(null);
                setArmedDeleteId(null);
            }
        },
        [
            armedDeleteId,
            keepMemories,
            loadCapacity,
            loadConversations,
            loadHistory,
        ]
    );

    if (capacityState.kind === "unauthenticated") {
        return (
            <div className="mx-auto w-full max-w-3xl px-4 py-10">
                <section className={sectionClass}>
                    <h1 className="text-lg font-bold">
                        {t("externalImport.pageTitle")}
                    </h1>
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                        {t("externalImport.signInRequired")}
                    </p>
                    <Link
                        href="/auth/signin"
                        className={`${primaryButtonClass} mt-4`}
                    >
                        {t("auth.login")}
                    </Link>
                </section>
            </div>
        );
    }

    const unfinished =
        historyState.kind === "ready"
            ? historyState.imports.filter((row) =>
                  UNFINISHED_STATUSES.has(row.status)
              )
            : [];
    const finishedHistory =
        historyState.kind === "ready"
            ? historyState.imports.filter(
                  (row) => !UNFINISHED_STATUSES.has(row.status)
              )
            : [];

    return (
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
            <div>
                <SettingsDetailNav
                    section="external-import"
                    currentLabel={t("externalImport.dataTabTitle")}
                    backTestId="external-import-back"
                />
                <h1 className="mt-3 text-xl font-bold">
                    {t("externalImport.pageTitle")}
                </h1>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("externalImport.pageDescription")}
                </p>
            </div>

            <section
                className={sectionClass}
                data-testid="external-import-privacy-note"
            >
                <p className="text-sm leading-6 text-zinc-500">
                    {t("externalImport.privacyNote")}
                </p>
            </section>

            {capacityState.kind === "disabled" ? (
                <section
                    className={sectionClass}
                    data-testid="external-import-disabled"
                >
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" />
                        <p className="text-sm leading-6 text-zinc-500">
                            {t("externalImport.disabledNotice")}
                        </p>
                    </div>
                </section>
            ) : (
                <>
                    {capacityState.kind === "ready" && (
                        <section
                            className={sectionClass}
                            data-testid="external-import-capacity"
                        >
                            <h2 className="text-sm font-bold">
                                {t("externalImport.capacityTitle")}
                            </h2>
                            <div className="mt-2 grid gap-1 text-sm leading-6 text-zinc-500">
                                <p>
                                    {interpolate(
                                        t("externalImport.capacityUsage"),
                                        {
                                            used: formatBytes(
                                                capacityState.capacity.usage
                                                    .normalizedTextBytes
                                            ),
                                            limit: formatBytes(
                                                capacityState.capacity.limits
                                                    .maxNormalizedTextBytes
                                            ),
                                        }
                                    )}
                                </p>
                                <p>
                                    {interpolate(
                                        t(
                                            "externalImport.capacityConversations"
                                        ),
                                        {
                                            used: capacityState.capacity.usage
                                                .externalConversations,
                                            limit: capacityState.capacity.limits
                                                .maxExternalConversations,
                                        }
                                    )}
                                </p>
                            </div>
                            <Link
                                href="/settings/imports/new"
                                className={`${primaryButtonClass} mt-4`}
                                data-testid="external-import-new"
                            >
                                <Plus className="h-4 w-4" />
                                {t("externalImport.newImportCta")}
                            </Link>
                        </section>
                    )}

                    {unfinished.length > 0 && (
                        <section
                            className={sectionClass}
                            data-testid="external-import-in-progress"
                        >
                            <h2 className="text-sm font-bold">
                                {t("externalImport.inProgressTitle")}
                            </h2>
                            <ul className="mt-3 space-y-2">
                                {unfinished.map((row) => (
                                    <UnfinishedImportCard
                                        key={row.id}
                                        row={row}
                                        armed={armedDeleteId === row.id}
                                        deleting={deletingId === row.id}
                                        onDelete={() =>
                                            void deleteImportRow(row.id)
                                        }
                                    />
                                ))}
                            </ul>
                        </section>
                    )}

                    {historyState.kind === "ready" &&
                        historyState.imports.length === 0 && (
                            <section
                                className={sectionClass}
                                data-testid="external-import-no-server-data"
                            >
                                <p className="text-sm leading-6 text-zinc-500">
                                    {t("externalImport.noServerDataYet")}
                                </p>
                            </section>
                        )}
                </>
            )}

            {conversationsState.kind !== "hidden" && (
                <section
                    className={sectionClass}
                    data-testid="external-import-conversations"
                >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-sm font-bold">
                            {t("externalImport.detailConversations")}
                        </h2>
                        {conversationsState.kind === "ready" &&
                            conversationsState.rows.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        window.location.href =
                                            "/api/imports/external/export";
                                    }}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                    data-testid="external-import-export"
                                >
                                    <Download className="h-3.5 w-3.5" />
                                    {t("externalImport.exportAll")}
                                </button>
                            )}
                    </div>
                    {conversationsState.kind === "loading" && (
                        <div className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
                            <Loader2 className="h-4 w-4 animate-spin" />
                        </div>
                    )}
                    {conversationsState.kind === "error" && (
                        <p className="mt-3 text-sm leading-6 text-zinc-500">
                            {t("externalImport.errorGeneric")}
                        </p>
                    )}
                    {conversationsState.kind === "ready" &&
                        conversationsState.rows.length === 0 && (
                            <p
                                className="mt-3 text-sm leading-6 text-zinc-500"
                                data-testid="external-import-conversations-empty"
                            >
                                {t("externalImport.conversationsEmpty")}
                            </p>
                        )}
                    {conversationsState.kind === "ready" &&
                        conversationsState.rows.length > 0 && (
                            <>
                                <ul className="mt-3 space-y-1">
                                    {groupConversationsByLineage(
                                        conversationsState.rows
                                    ).map((group) => (
                                        <LineageGroupRow
                                            key={group.latest.id}
                                            group={group}
                                            expanded={expandedLineages.has(
                                                group.latest.id
                                            )}
                                            onToggleExpanded={() =>
                                                setExpandedLineages(
                                                    (current) => {
                                                        const next = new Set(
                                                            current
                                                        );
                                                        if (
                                                            next.has(
                                                                group.latest.id
                                                            )
                                                        ) {
                                                            next.delete(
                                                                group.latest.id
                                                            );
                                                        } else {
                                                            next.add(
                                                                group.latest.id
                                                            );
                                                        }
                                                        return next;
                                                    }
                                                )
                                            }
                                        />
                                    ))}
                                </ul>
                                {conversationsState.rows.length <
                                    conversationsState.total && (
                                    <button
                                        type="button"
                                        className={`${secondaryButtonClass} mt-3 w-full`}
                                        data-testid="external-import-conversations-more"
                                        onClick={() =>
                                            void loadConversations({
                                                append: true,
                                            })
                                        }
                                    >
                                        {t("externalImport.loadMore")}
                                    </button>
                                )}
                            </>
                        )}
                </section>
            )}

            <section
                className={sectionClass}
                data-testid="external-import-history"
            >
                <h2 className="text-sm font-bold">
                    {t("externalImport.historyTitle")}
                </h2>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {t("externalImport.deleteNote")}
                </p>
                {historyState.kind === "loading" && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                )}
                {historyState.kind === "error" && (
                    <p className="mt-3 text-sm leading-6 text-zinc-500">
                        {t("externalImport.errorGeneric")}
                    </p>
                )}
                {historyState.kind === "ready" &&
                    finishedHistory.length === 0 && (
                        <p
                            className="mt-3 text-sm leading-6 text-zinc-500"
                            data-testid="external-import-history-empty"
                        >
                            {t("externalImport.historyEmpty")}
                        </p>
                    )}
                {historyState.kind === "ready" && finishedHistory.length > 0 && (
                    <ul className="mt-3 space-y-2">
                        {finishedHistory.map((row) => (
                            <li
                                key={row.id}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/60"
                                data-testid="external-import-history-row"
                            >
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                        {providerLabel(row.provider)}
                                        <span className="ml-2 text-xs font-medium text-zinc-500">
                                            {new Date(
                                                row.createdAt
                                            ).toLocaleDateString()}
                                        </span>
                                    </p>
                                    <p className="mt-0.5 text-xs leading-5 text-zinc-500">
                                        {IMPORT_STATUS_KEYS[row.status]
                                            ? t(IMPORT_STATUS_KEYS[row.status])
                                            : row.status}
                                        {" · "}
                                        {interpolate(
                                            t(
                                                "externalImport.historyConversations"
                                            ),
                                            { count: row.conversationCount }
                                        )}
                                        {" · "}
                                        {formatBytes(row.normalizedBytes)}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    {row.status === "completed" && (
                                        <Link
                                            href={`/settings/imports/${row.id}`}
                                            className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                            data-testid="external-import-history-view"
                                        >
                                            {t("externalImport.viewDetail")}
                                        </Link>
                                    )}
                                    <button
                                        type="button"
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70"
                                        data-testid="external-import-history-delete"
                                        disabled={deletingId === row.id}
                                        onClick={() =>
                                            void deleteImportRow(row.id)
                                        }
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                        {deletingId === row.id
                                            ? t("externalImport.deleting")
                                            : armedDeleteId === row.id
                                              ? t(
                                                    "externalImport.deleteImportArmed"
                                                )
                                              : t("externalImport.deleteImport")}
                                    </button>
                                </div>
                                {armedDeleteId === row.id ? (
                                    <SourceDeletionNotice
                                        impact={memoryImpact}
                                        scope="import"
                                        keepDerived={keepMemories}
                                        onKeepDerivedChange={setKeepMemories}
                                    />
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

/**
 * One unfinished import. The three offers differ because the three states
 * genuinely differ — see the module comment. "Finish this import" appears
 * only for a sealed, unexpired run.
 */
function UnfinishedImportCard({
    row,
    armed,
    deleting,
    onDelete,
}: {
    row: ImportHistoryRow;
    armed: boolean;
    deleting: boolean;
    onDelete: () => void;
}) {
    const { t } = useLanguage();
    const expired = row.expired === true;
    const resumable = row.resumable === true && !expired;
    return (
        <li
            className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/60"
            data-testid="external-import-in-progress-card"
            data-resumable={resumable ? "true" : "false"}
            data-expired={expired ? "true" : "false"}
        >
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {providerLabel(row.provider)}
                <span className="ml-2 text-xs font-medium text-zinc-500">
                    {new Date(row.createdAt).toLocaleDateString()}
                </span>
            </p>
            <p className="mt-0.5 text-xs leading-5 text-zinc-500">
                {expired
                    ? t("externalImport.statusExpired")
                    : IMPORT_STATUS_KEYS[row.status]
                      ? t(IMPORT_STATUS_KEYS[row.status])
                      : row.status}
                {" · "}
                {interpolate(t("externalImport.historyConversations"), {
                    count: row.conversationCount,
                })}
            </p>
            {expired ? (
                <p
                    className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-amber-700 dark:text-amber-300"
                    data-testid="external-import-expired-card"
                >
                    <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t("externalImport.expiredCardNotice")}
                </p>
            ) : (
                !resumable && (
                    <p
                        className="mt-1 text-xs leading-5 text-zinc-500"
                        data-testid="external-import-not-resumable"
                    >
                        {t("externalImport.inProgressNotResumable")}
                    </p>
                )
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
                {resumable && (
                    <Link
                        href={`/settings/imports/${row.id}`}
                        className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                        data-testid="external-import-resume"
                    >
                        {t("externalImport.inProgressResume")}
                    </Link>
                )}
                <Link
                    href="/settings/imports/new"
                    className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                    data-testid="external-import-restart"
                >
                    {t("externalImport.inProgressRestart")}
                </Link>
                <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
                    data-testid="external-import-discard"
                    disabled={deleting}
                    onClick={onDelete}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleting
                        ? t("externalImport.deleting")
                        : armed
                          ? t("externalImport.deleteImportArmed")
                          : t("externalImport.deleteImport")}
                </button>
            </div>
        </li>
    );
}

function ConversationRowLink({ row }: { row: ViewerConversationRow }) {
    const { t } = useLanguage();
    return (
        <Link
            href={`/settings/imports/conversations/${row.id}`}
            className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            data-testid="external-import-conversation-link"
        >
            <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {row.title}
                </span>
                {/* Said in the list, not only on the page it guards: opening a
                    snapshot to find a password prompt is a worse answer than
                    knowing before the click (§7). */}
                {row.locked ? (
                    <span
                        className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                        data-testid="external-import-conversation-locked"
                    >
                        <Lock className="h-3 w-3" />
                        {t("externalImport.lockedBadge")}
                    </span>
                ) : null}
                <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
                    {providerLabel(row.provider)}
                    {" · "}
                    {interpolate(t("externalImport.messagesCount"), {
                        count: row.messageCount,
                    })}
                    {" · "}
                    {new Date(row.importedAt).toLocaleDateString()}
                </span>
            </span>
        </Link>
    );
}

/**
 * One source lineage (§4.2): the latest snapshot up front, earlier immutable
 * snapshots behind an explicit disclosure, each individually openable (and
 * deletable from its viewer page).
 */
function LineageGroupRow({
    group,
    expanded,
    onToggleExpanded,
}: {
    group: LineageGroup<ViewerConversationRow>;
    expanded: boolean;
    onToggleExpanded: () => void;
}) {
    const { t } = useLanguage();
    return (
        <li data-testid="external-import-lineage">
            <ConversationRowLink row={group.latest} />
            {group.previous.length > 0 && (
                <div className="mt-1 pl-4">
                    <button
                        type="button"
                        className="text-xs font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                        data-testid="external-import-lineage-toggle"
                        aria-expanded={expanded}
                        onClick={onToggleExpanded}
                    >
                        {interpolate(t("externalImport.previousSnapshots"), {
                            count: group.previous.length,
                        })}
                    </button>
                    {expanded && (
                        <ul className="mt-1 space-y-1">
                            {group.previous.map((row) => (
                                <li key={row.id}>
                                    <ConversationRowLink row={row} />
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </li>
    );
}
