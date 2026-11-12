"use client";
import Link from "next/link";
import { useEffect, useState, type ComponentProps } from "react";
import {
    ArrowRight,
    Brain,
    CheckCheck,
    Loader2,
    MessageSquare,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { ContinuationQuickAction } from "@/components/imports/ContinuationQuickAction";
import { importedConversationTitle } from "@/components/imports/importedConversationTitle";
import { displayTimeZoneHeaders } from "@/lib/continuationTitleContext";
import {
    interpolate,
    providerLabel,
    secondaryButtonClass,
} from "@/components/imports/importFormatting";
import { useImportMemoryState } from "./ImportMemoryNotice";

type SavedRow = Pick<
    ComponentProps<typeof ContinuationQuickAction>,
    "locked" | "continuationCount" | "latestContinuationId" | "continuations"
> & {
    id: string;
    importId: string;
    title: string | null;
    messageCount: number;
    provider: string;
};

export function ImportCompletedStep({
    importId,
    initialCount,
    onStartAnother,
}: {
    importId: string;
    initialCount?: number;
    onStartAnother: () => void;
}) {
    const { t } = useLanguage();
    const memory = useImportMemoryState();
    const [page, setPage] = useState(0);
    const [loaded, setLoaded] = useState<{
        page: number;
        rows: SavedRow[];
        total: number;
        enabled: boolean;
    } | null>(null);
    const [failed, setFailed] = useState(false);
    const [retry, setRetry] = useState(0);
    const [quote, setQuote] = useState<{ id: string; text: string } | null>(
        null,
    );
    useEffect(() => {
        const controller = new AbortController();
        const signal = controller.signal;
        void (async () => {
            const res = await fetch(
                `/api/external-conversations?importId=${encodeURIComponent(importId)}&offset=${page * 50}&limit=50`,
                {
                    cache: "no-store",
                    signal,
                    headers: displayTimeZoneHeaders(),
                },
            );
            if (!res.ok) throw Error();
            const body = await res.json();
            const rows: SavedRow[] = body.conversations.filter(
                (row: SavedRow) => row.importId === importId,
            );
            if (signal.aborted) return;
            setFailed(false);
            setLoaded({
                rows,
                total: body.total,
                page,
                enabled: body.continuationEnabled === true,
            });
            const row = rows[0];
            if (body.total !== 1 || !row || row.locked || !row.messageCount)
                return;
            try {
                const last = await fetch(
                    `/api/external-conversations/${encodeURIComponent(row.id)}?offset=${row.messageCount - 1}&limit=1`,
                    { cache: "no-store", signal },
                );
                if (!last.ok) return;
                const data = await last.json();
                const text = data.messages?.[0]?.content;
                if (!signal.aborted && typeof text === "string")
                    setQuote({ id: row.id, text: text.slice(-240) });
            } catch {
                /* Optional preview. */
            }
        })().catch(() => {
            if (!signal.aborted) setFailed(true);
        });
        return () => controller.abort();
    }, [importId, page, retry]);
    const count = loaded?.total ?? initialCount;
    return (
        <div data-testid="external-import-completed" className="space-y-5">
            <span className="inline-flex size-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                <CheckCheck size={22} />
            </span>
            <header>
                <h2>
                    {count === undefined
                        ? t("externalImport.stepDone")
                        : interpolate(t("journey.saved"), { count })}
                </h2>
                {count !== undefined && count > 0 && (
                    <p>
                        {t(
                            loaded?.enabled === false
                                ? "journey.stored"
                                : count === 1
                                  ? "journey.continueHint"
                                  : "journey.pickHint",
                        )}
                    </p>
                )}
            </header>
            {failed ? (
                <div role="alert">
                    {t("journey.loadError")}{" "}
                    <button
                        onClick={() => {
                            setFailed(false);
                            setRetry((x) => x + 1);
                        }}
                    >
                        {t("journey.retry")}
                    </button>
                </div>
            ) : loaded?.page !== page ? (
                <Loader2
                    className="animate-spin"
                    aria-label={t("journey.loading")}
                />
            ) : (
                <ul className="space-y-3">
                    {loaded.rows.map((row) => {
                        const title = importedConversationTitle(row, t);
                        return (
                            <li key={row.id} className="journey-result">
                                <div className="journey-card">
                                    <MessageSquare
                                        size={20}
                                        className="float-left mr-3 box-content rounded-xl bg-blue-50 p-3 text-blue-600"
                                    />
                                    <h3>{title}</h3>
                                    <p>
                                        {providerLabel(row.provider)} ·{" "}
                                        {interpolate(
                                            t("externalImport.messagesCount"),
                                            { count: row.messageCount },
                                        )}
                                    </p>
                                    {!row.locked && quote?.id === row.id && (
                                        <blockquote>
                                            <small className="block pb-1 text-xs font-semibold">
                                                {t("journey.lastMessage")}
                                            </small>
                                            {quote.text}
                                        </blockquote>
                                    )}
                                </div>
                                <div className="journey-actions">
                                    {loaded.enabled && (
                                        <ContinuationQuickAction
                                            externalConversationId={row.id}
                                            sourceTitle={title}
                                            primaryLabel={t("journey.again")}
                                            locked={row.locked}
                                            continuationCount={
                                                row.continuationCount
                                            }
                                            latestContinuationId={
                                                row.latestContinuationId
                                            }
                                            continuations={row.continuations}
                                        />
                                    )}
                                    <Link
                                        className={secondaryButtonClass}
                                        href={`/settings/imports/conversations/${encodeURIComponent(row.id)}?fromImport=${encodeURIComponent(importId)}`}
                                    >
                                        {t("journey.original")}
                                    </Link>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            {loaded && loaded.total > 50 && (
                <div className="journey-actions">
                    <button
                        disabled={!page}
                        onClick={() => setPage((p) => p - 1)}
                    >
                        {t("externalImport.back")}
                    </button>
                    <button
                        disabled={(page + 1) * 50 >= loaded.total}
                        onClick={() => setPage((p) => p + 1)}
                    >
                        {t("journey.next")}
                    </button>
                </div>
            )}
            <Link
                href={`/settings/memory?fromImport=${encodeURIComponent(importId)}`}
                className="journey-memory"
            >
                <Brain size={22} />
                <span>
                    <strong>{t("journey.memory")}</strong>
                    <small>
                        {t(
                            memory === "off"
                                ? "journey.memoryOff"
                                : memory === "organising"
                                  ? "journey.organising"
                                  : "journey.memoryWhere",
                        )}
                    </small>
                </span>
                <ArrowRight size={18} />
            </Link>
            <div className="journey-actions">
                <button type="button" onClick={onStartAnother}>
                    {t("externalImport.startAnother")}
                </button>
                <Link
                    href="/settings/imports"
                    data-testid="external-import-completed-manage"
                >
                    {t("externalImport.backToImports")}
                </Link>
            </div>
        </div>
    );
}
