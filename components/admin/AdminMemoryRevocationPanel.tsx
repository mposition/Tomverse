"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, OctagonX, RefreshCw, ShieldAlert } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

/**
 * The §12.1 emergency revocation control.
 *
 * It sits beside the extraction report rather than with the feature flags,
 * because this is the screen where an operator sees one pair failing where the
 * others are not -- and the action they need next is to stop that pair. Acting
 * where the evidence is means not carrying a model id across a navigation.
 *
 * It only restricts. There is no enable here: turning memory injection on is
 * the §12.4 human procedure, and a control that could both stop and start
 * would put half of that procedure behind a button.
 *
 * The register list is offered as checkboxes so that the common case is a
 * choice rather than a typed string. Typing one is still possible, because an
 * emergency control has to work for a pair the register no longer lists -- and
 * the server answers with which typed labels it recognised, since an unknown
 * label is both a legitimate action and what a typo looks like.
 */

type RevokedView = {
    kind: "none" | "revoked" | "revoke_all";
    reason?: "malformed" | "operator";
    pairs: string[];
};

type RegisterRow = {
    label: string;
    extractionModelId: string;
    promptVersion: string;
    status: string;
    owner: string;
};

type RevocationResponse = {
    revoked: RevokedView;
    register: RegisterRow[];
    canWrite?: boolean;
    unknownLabels?: string[];
};

const stateSentence = (revoked: RevokedView) => {
    if (revoked.kind === "none") return "Nothing is revoked. Every approved pair may run.";
    if (revoked.kind === "revoke_all") {
        return revoked.reason === "operator"
            ? "All extraction is stopped by an operator. No pair may run."
            : "The stored revocation list is unreadable, so every pair is treated as revoked. No pair may run until it is rewritten.";
    }
    return `${revoked.pairs.length} pair(s) revoked. They cannot run; other approved pairs can.`;
};

export function AdminMemoryRevocationPanel() {
    const [data, setData] = useState<RevocationResponse | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [extraLabels, setExtraLabels] = useState("");
    const [reason, setReason] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [problems, setProblems] = useState<string[]>([]);
    // Starts true: the mount effect loads immediately, and writing it there
    // synchronously would be a set-state-in-effect violation.
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    const apply = useCallback((response: RevocationResponse) => {
        setData(response);
        setSelected(response.revoked.kind === "revoked" ? response.revoked.pairs : []);
    }, []);

    const load = useCallback(async () => {
        try {
            const response = await fetch(
                "/api/admin/memory-extraction/revocations",
                { cache: "no-store" }
            );
            const body = (await response.json().catch(() => null)) as
                | RevocationResponse
                | { error?: string }
                | null;
            if (!response.ok || !body || "error" in body) {
                throw new Error(
                    (body && "error" in body && body.error) ||
                        "Failed to load extraction revocations."
                );
            }
            setError(null);
            apply(body as RevocationResponse);
        } catch (loadError) {
            setError(
                loadError instanceof Error
                    ? loadError.message
                    : "Failed to load extraction revocations."
            );
        } finally {
            setIsLoading(false);
        }
    }, [apply]);

    useEffect(() => {
        // Deferred a tick so no state write is synchronous within the effect.
        queueMicrotask(() => void load());
    }, [load]);

    const typedLabels = extraLabels
        .split(/[\n,]/)
        .map((label) => label.trim())
        .filter(Boolean);
    const requestedLabels = [...new Set([...selected, ...typedLabels])];
    const canWrite = data?.canWrite !== false;

    const submit = async (mode: "none" | "pairs" | "all") => {
        setIsSaving(true);
        setProblems([]);
        try {
            const response = await fetch(
                "/api/admin/memory-extraction/revocations",
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        mode,
                        labels: mode === "pairs" ? requestedLabels : undefined,
                        reason,
                    }),
                }
            );
            const body = (await response.json().catch(() => null)) as
                | (RevocationResponse & { problems?: string[]; error?: string })
                | null;
            if (!response.ok || !body || body.error) {
                setProblems(body?.problems ?? []);
                throw new Error(
                    body?.error || "The revocation could not be saved. Nothing changed."
                );
            }
            apply(body);
            setExtraLabels("");
            setReason("");
            setError(null);
            const unknown = body.unknownLabels ?? [];
            dispatchAppToast(
                unknown.length > 0
                    ? `Saved. ${unknown.length} label(s) are not in the register: ${unknown.join(", ")}. Check them if that was not deliberate.`
                    : "Saved. The next extraction reads this immediately.",
                unknown.length > 0 ? "info" : "success"
            );
        } catch (saveError) {
            const message =
                saveError instanceof Error
                    ? saveError.message
                    : "The revocation could not be saved. Nothing changed.";
            setError(message);
            dispatchAppToast(message, "error");
        } finally {
            setIsSaving(false);
        }
    };

    const busy = isLoading || isSaving;
    const disabled = busy || !canWrite || reason.trim() === "";

    return (
        <section
            data-testid="admin-memory-revocation-panel"
            className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 shadow-2xl shadow-black/20"
        >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 p-5">
                <div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-amber-200">
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Emergency revocation
                    </div>
                    <h2 className="mt-3 text-2xl font-black text-white">
                        Stop an extraction pair without a deploy
                    </h2>
                    <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
                        Revocation takes effect on the next extraction and on the next
                        injected memory — there is no cache to wait out. It only ever
                        restricts: enabling memory is the §12.4 human procedure and is
                        deliberately not on this screen.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => {
                        setIsLoading(true);
                        void load();
                    }}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <RefreshCw className="h-4 w-4" />
                    )}
                    Refresh
                </button>
            </div>

            {error && (
                <p
                    className="border-b border-red-900/50 bg-red-950/30 px-5 py-3 text-sm font-semibold text-red-300"
                    data-testid="admin-memory-revocation-error"
                >
                    {error}
                </p>
            )}

            {problems.length > 0 && (
                <ul
                    className="border-b border-red-900/50 bg-red-950/20 px-5 py-3 text-sm text-red-200"
                    data-testid="admin-memory-revocation-problems"
                >
                    {problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                    ))}
                </ul>
            )}

            {data && (
                <div className="grid gap-5 p-5">
                    <p
                        className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm font-semibold text-zinc-200"
                        data-testid="admin-memory-revocation-state"
                    >
                        {stateSentence(data.revoked)}
                    </p>

                    <fieldset className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                        <legend className="px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                            Registered pairs
                        </legend>
                        {data.register.length === 0 ? (
                            <p className="mt-2 text-sm text-zinc-500">
                                The register lists no pairs.
                            </p>
                        ) : (
                            <ul className="mt-2 space-y-2">
                                {data.register.map((entry) => (
                                    <li key={entry.label}>
                                        <label className="flex items-center gap-3 text-sm text-zinc-300">
                                            <input
                                                type="checkbox"
                                                checked={selected.includes(entry.label)}
                                                disabled={busy || !canWrite}
                                                onChange={(event) =>
                                                    setSelected((current) =>
                                                        event.target.checked
                                                            ? [...current, entry.label]
                                                            : current.filter(
                                                                  (label) =>
                                                                      label !== entry.label
                                                              )
                                                    )
                                                }
                                                className="h-4 w-4"
                                            />
                                            <span className="font-mono text-xs text-white">
                                                {entry.label}
                                            </span>
                                            <span className="text-xs text-zinc-500">
                                                {entry.status} · {entry.owner}
                                            </span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </fieldset>

                    <div className="grid gap-2">
                        <label
                            htmlFor="revocation-extra-labels"
                            className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500"
                        >
                            Other pairs, one per line
                        </label>
                        <textarea
                            id="revocation-extra-labels"
                            rows={2}
                            value={extraLabels}
                            disabled={busy || !canWrite}
                            onChange={(event) => setExtraLabels(event.target.value)}
                            placeholder="model-id::prompt-version"
                            className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-white placeholder:text-zinc-600 disabled:opacity-60"
                        />
                        <p className="text-xs text-zinc-500">
                            For a pair the register no longer lists. A label that is not
                            registered is saved and reported back, not refused.
                        </p>
                    </div>

                    <div className="grid gap-2">
                        <label
                            htmlFor="revocation-reason"
                            className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500"
                        >
                            Reason (recorded in the audit log)
                        </label>
                        <textarea
                            id="revocation-reason"
                            rows={2}
                            value={reason}
                            disabled={busy || !canWrite}
                            onChange={(event) => setReason(event.target.value)}
                            className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-white disabled:opacity-60"
                        />
                    </div>

                    {!canWrite && (
                        <p className="text-sm font-semibold text-amber-300">
                            Your admin role can read this but not change it. Revocation
                            needs the ops write permission.
                        </p>
                    )}

                    <div className="flex flex-wrap gap-3">
                        <button
                            type="button"
                            data-testid="admin-memory-revocation-save"
                            disabled={disabled}
                            onClick={() =>
                                void submit(requestedLabels.length === 0 ? "none" : "pairs")
                            }
                            className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                            {requestedLabels.length === 0
                                ? "Clear all revocations"
                                : `Revoke ${requestedLabels.length} pair(s)`}
                        </button>
                        <button
                            type="button"
                            data-testid="admin-memory-revocation-stop-all"
                            disabled={disabled}
                            onClick={() => void submit("all")}
                            className="inline-flex items-center gap-2 rounded-xl border border-red-700 px-4 py-2 text-sm font-bold text-red-200 hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <OctagonX className="h-4 w-4" />
                            Stop all extraction
                        </button>
                    </div>
                    <p className="text-xs text-zinc-500">
                        A reason is required before either action is available.
                    </p>
                </div>
            )}
        </section>
    );
}
