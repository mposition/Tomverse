"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";

type Peer = { id: string; statement: string; revision: number };
const button = "rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs disabled:opacity-50 dark:border-zinc-700";

export function MemoryConflictReview({ memoryId, activeMemories, disabled, onResolve, onCancel }: {
    memoryId: string;
    activeMemories: Peer[];
    disabled: boolean;
    onResolve: (body: Record<string, unknown>) => Promise<void>;
    onCancel: () => void;
}) {
    const { t } = useLanguage();
    const [context, setContext] = useState<{ memory: Peer; conflicts: Peer[] } | null>(null);
    const [failed, setFailed] = useState(false);
    const [otherId, setOtherId] = useState("");
    const [merging, setMerging] = useState(false);
    const [statement, setStatement] = useState("");
    const [grounds, setGrounds] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        void fetch(`/api/memories/${memoryId}`, { cache: "no-store", signal: controller.signal })
            .then(async response => {
                if (!response.ok) throw new Error("memory_conflict_unavailable");
                const body = await response.json();
                if (!body.memory || !Array.isArray(body.conflicts)) throw new Error("memory_conflict_unavailable");
                setContext(body);
                setStatement(body.memory.statement);
            }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
        return () => controller.abort();
    }, [memoryId]);
    const peers = context?.conflicts.length ? context.conflicts : activeMemories.filter(row => row.id === otherId && row.id !== memoryId);
    const resolve = (resolution: string) => {
        if (!context || !peers.length) return;
        return onResolve({ action: "resolve_conflict", resolution,
            expectedRevision: context.memory.revision,
            expectedConflicts: peers.map(({ id, revision }) => ({ id, revision })),
            ...(!context.conflicts.length ? { otherMemoryId: otherId } : {}),
            ...(resolution === "merge" ? { mergedStatement: statement.trim(), groundsText: grounds.trim() } : {}),
        });
    };
    const blocked = disabled || !context || !peers.length || failed;
    return <div className="mt-2 space-y-2 rounded-lg border border-amber-300 p-3 dark:border-amber-800" data-testid="memory-conflict">
        <p className="text-xs leading-5">{t("memoryReview.conflictNotice")}</p>
        {failed ? <p role="alert">{t("memoryReview.errorGeneric")}</p> : !context ? <p role="status">{t("memoryReview.conflictLoading")}</p> : <>
            <p className="text-sm">{context.memory.statement}</p>
            {!context.conflicts.length && <label className="block text-xs">{t("memoryReview.conflictChoose")}
                <select className="mt-1 block w-full rounded border bg-transparent p-2" value={otherId}
                    data-testid="memory-conflict-other" onChange={event => setOtherId(event.target.value)}>
                    <option value="">{t("memoryReview.conflictChoose")}</option>
                    {activeMemories.filter(row => row.id !== memoryId).map(row => <option key={row.id} value={row.id}>{row.statement}</option>)}
                </select>
            </label>}
            <ul className="list-disc pl-4 text-sm" data-testid="memory-conflict-peers">{peers.map(row => <li key={row.id}>{row.statement}</li>)}</ul>
        </>}
        <div className="flex flex-wrap gap-2">
            {([ ["keep_existing", "conflictKeep", "keep"], ["replace_existing", "conflictReplace", "replace"],
                ["keep_both", "conflictBoth", "both"], ["expire_existing", "conflictExpire", "expire"] ] as const).map(([resolution, label, testId]) =>
                <button key={resolution} type="button" className={button} disabled={blocked}
                    data-testid={`memory-conflict-${testId}`} onClick={() => void resolve(resolution)}>{t(`memoryReview.${label}`)}</button>)}
            <button type="button" className={button} disabled={blocked} data-testid="memory-conflict-merge"
                onClick={() => setMerging(true)}>{t("memoryReview.conflictMerge")}</button>
            <button type="button" className={button} disabled={disabled} onClick={onCancel}>{t("memoryReview.cancel")}</button>
        </div>
        {merging && <div className="space-y-2">
            <label className="block text-xs">{t("memoryReview.conflictMergedStatement")}
                <textarea className="mt-1 block w-full rounded border bg-transparent p-2 text-sm" value={statement} maxLength={1000}
                    data-testid="memory-conflict-merged-statement" onChange={event => setStatement(event.target.value)} />
            </label>
            <label className="block text-xs">{t("memoryReview.conflictMergeGrounds")}
                <textarea className="mt-1 block w-full rounded border bg-transparent p-2 text-sm" value={grounds} maxLength={2000}
                    data-testid="memory-conflict-grounds" onChange={event => setGrounds(event.target.value)} />
            </label>
            <button type="button" className={button} data-testid="memory-conflict-merge-save"
                disabled={blocked || !statement.trim() || !grounds.trim()} onClick={() => void resolve("merge")}>{t("memoryReview.save")}</button>
        </div>}
    </div>;
}
