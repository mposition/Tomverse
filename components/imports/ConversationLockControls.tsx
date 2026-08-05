"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock, LockOpen } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { interpolate } from "@/components/imports/importFormatting";

/**
 * The snapshot lock's two faces (policy §7, §7.1).
 *
 * `SnapshotUnlockGate` is what a locked snapshot shows instead of its
 * content: the only thing on the page, because the point of the lock is that
 * nothing else is there to read. `SnapshotLockPanel` is the owner's control
 * over the lock once they are past it.
 *
 * Both talk to the server for every decision. Nothing here is allowed to
 * conclude that a password was right, that a snapshot is locked, or that a
 * memory will be suspended — the client renders answers, it does not compute
 * them.
 */

const inputClass =
    "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100";

const primaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";

const secondaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

/** Minimum accepted by the server; stated so the field can say it up front. */
const MIN_PASSWORD_LENGTH = 8;

const lockUrl = (conversationId: string, suffix = "") =>
    `/api/external-conversations/${encodeURIComponent(conversationId)}/lock${suffix}`;

type SourceLockImpactView = {
    blockedCount: number;
    backedCount: number;
};

/**
 * A failed attempt reads the same whatever went wrong, except for the one
 * distinction that changes what the user should do: being rate limited means
 * waiting, not trying harder.
 */
type AttemptError = "invalid" | "rate_limited" | "generic" | null;

const attemptErrorFrom = (status: number): AttemptError =>
    status === 429 ? "rate_limited" : status === 403 ? "invalid" : "generic";

function AttemptErrorNotice({ error }: { error: AttemptError }) {
    const { t } = useLanguage();
    if (!error) return null;
    return (
        <p
            className="mt-2 text-xs leading-5 text-red-600 dark:text-red-300"
            role="alert"
            data-testid="snapshot-lock-error"
        >
            {t(
                error === "rate_limited"
                    ? "externalImport.lockTooManyAttempts"
                    : error === "invalid"
                      ? "externalImport.lockWrongPassword"
                      : "externalImport.lockFailed"
            )}
        </p>
    );
}

/** What a locked snapshot shows in place of its content. */
export function SnapshotUnlockGate({
    conversationId,
    onUnlocked,
}: {
    conversationId: string;
    onUnlocked: () => void;
}) {
    const { t } = useLanguage();
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<AttemptError>(null);

    const submit = useCallback(async () => {
        if (busy || password.length === 0) return;
        setBusy(true);
        setError(null);
        try {
            const response = await fetch(lockUrl(conversationId, "/verify"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ password }),
            });
            if (response.ok) {
                setPassword("");
                onUnlocked();
                return;
            }
            setError(attemptErrorFrom(response.status));
        } catch {
            setError("generic");
        } finally {
            setBusy(false);
        }
    }, [busy, conversationId, onUnlocked, password]);

    return (
        <section
            className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
            data-testid="snapshot-unlock-gate"
        >
            <h2 className="flex items-center gap-2 text-base font-bold text-zinc-900 dark:text-zinc-100">
                <Lock className="h-4 w-4" />
                {t("externalImport.lockGateTitle")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
                {t("externalImport.lockGateDescription")}
            </p>
            <form
                className="mt-3 space-y-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                <label
                    className="block text-xs font-semibold text-zinc-500"
                    htmlFor="snapshot-unlock-password"
                >
                    {t("externalImport.lockPasswordLabel")}
                </label>
                <input
                    id="snapshot-unlock-password"
                    type="password"
                    className={inputClass}
                    autoComplete="off"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    data-testid="snapshot-unlock-password"
                />
                <AttemptErrorNotice error={error} />
                <button
                    type="submit"
                    className={primaryButtonClass}
                    disabled={busy || password.length === 0}
                    data-testid="snapshot-unlock-submit"
                >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("externalImport.lockUnlockCta")}
                </button>
            </form>
        </section>
    );
}

type PanelForm = "none" | "set" | "change" | "remove";

/** The owner's control over the lock, shown once they are past it. */
export function SnapshotLockPanel({
    conversationId,
    locked,
    onChanged,
}: {
    conversationId: string;
    locked: boolean;
    onChanged: (locked: boolean) => void;
}) {
    const { t } = useLanguage();
    const [form, setForm] = useState<PanelForm>("none");
    const [password, setPassword] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<AttemptError>(null);
    const [impact, setImpact] = useState<SourceLockImpactView | null>(null);

    const reset = useCallback(() => {
        setForm("none");
        setPassword("");
        setCurrentPassword("");
        setError(null);
    }, []);

    // Fetched when the set form opens, not on mount: the number is only owed
    // to someone about to lock, and asking for it earlier is a query per page
    // view that nobody reads (§7.1, following §13.1's pattern).
    useEffect(() => {
        if (form !== "set" || impact) return;
        let cancelled = false;
        queueMicrotask(() => {
            void fetch(lockUrl(conversationId), { cache: "no-store" })
                .then((response) => (response.ok ? response.json() : null))
                .then((body: { memoryImpact?: SourceLockImpactView } | null) => {
                    if (cancelled || !body?.memoryImpact) return;
                    setImpact(body.memoryImpact);
                })
                .catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [conversationId, form, impact]);

    const submit = useCallback(
        async (next: string | null) => {
            if (busy) return;
            setBusy(true);
            setError(null);
            try {
                const response = await fetch(lockUrl(conversationId), {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        password: next,
                        // Only sent when there is something to prove; the
                        // server decides whether it was needed.
                        ...(locked ? { currentPassword } : {}),
                    }),
                });
                if (response.ok) {
                    setImpact(null);
                    reset();
                    onChanged(next !== null);
                    return;
                }
                setError(attemptErrorFrom(response.status));
            } catch {
                setError("generic");
            } finally {
                setBusy(false);
            }
        },
        [busy, conversationId, currentPassword, locked, onChanged, reset]
    );

    return (
        <section
            className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
            data-testid="snapshot-lock-panel"
        >
            <h2 className="flex items-center gap-2 text-base font-bold text-zinc-900 dark:text-zinc-100">
                {locked ? (
                    <Lock className="h-4 w-4" />
                ) : (
                    <LockOpen className="h-4 w-4" />
                )}
                {t("externalImport.lockSectionTitle")}
            </h2>
            <p
                className="mt-1 text-sm leading-6 text-zinc-500"
                data-testid="snapshot-lock-status"
            >
                {t(
                    locked
                        ? "externalImport.lockStatusLocked"
                        : "externalImport.lockStatusUnlocked"
                )}
            </p>

            {form === "none" ? (
                <div className="mt-3 flex flex-wrap gap-2">
                    {locked ? (
                        <>
                            <button
                                type="button"
                                className={secondaryButtonClass}
                                onClick={() => setForm("change")}
                                data-testid="snapshot-lock-change"
                            >
                                {t("externalImport.lockChangeCta")}
                            </button>
                            <button
                                type="button"
                                className={secondaryButtonClass}
                                onClick={() => setForm("remove")}
                                data-testid="snapshot-lock-remove"
                            >
                                {t("externalImport.lockRemoveCta")}
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            className={primaryButtonClass}
                            onClick={() => setForm("set")}
                            data-testid="snapshot-lock-set"
                        >
                            <Lock className="h-4 w-4" />
                            {t("externalImport.lockSetCta")}
                        </button>
                    )}
                </div>
            ) : null}

            {form !== "none" ? (
                <form
                    className="mt-3 space-y-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit(form === "remove" ? null : password);
                    }}
                >
                    {locked ? (
                        <>
                            <label
                                className="block text-xs font-semibold text-zinc-500"
                                htmlFor="snapshot-lock-current"
                            >
                                {t("externalImport.lockCurrentPasswordLabel")}
                            </label>
                            <input
                                id="snapshot-lock-current"
                                type="password"
                                className={inputClass}
                                autoComplete="off"
                                value={currentPassword}
                                onChange={(event) =>
                                    setCurrentPassword(event.target.value)
                                }
                                data-testid="snapshot-lock-current"
                            />
                        </>
                    ) : null}

                    {form !== "remove" ? (
                        <>
                            <label
                                className="block text-xs font-semibold text-zinc-500"
                                htmlFor="snapshot-lock-new"
                            >
                                {t("externalImport.lockNewPasswordLabel")}
                            </label>
                            <input
                                id="snapshot-lock-new"
                                type="password"
                                className={inputClass}
                                autoComplete="off"
                                value={password}
                                onChange={(event) =>
                                    setPassword(event.target.value)
                                }
                                data-testid="snapshot-lock-new"
                            />
                            <p className="text-xs leading-5 text-zinc-500">
                                {interpolate(
                                    t("externalImport.lockPasswordHint"),
                                    { count: MIN_PASSWORD_LENGTH }
                                )}
                            </p>
                        </>
                    ) : null}

                    {form === "set" ? (
                        <>
                            <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
                                {t("externalImport.lockNoRecoveryWarning")}
                            </p>
                            <SourceLockNotice impact={impact} />
                        </>
                    ) : null}
                    {form === "remove" ? (
                        <p
                            className="text-xs leading-5 text-zinc-500"
                            data-testid="snapshot-lock-remove-note"
                        >
                            {t("memoryReview.sourceLockRestoreNote")}
                        </p>
                    ) : null}

                    <AttemptErrorNotice error={error} />

                    <div className="flex flex-wrap gap-2">
                        <button
                            type="submit"
                            className={primaryButtonClass}
                            disabled={
                                busy ||
                                (locked && currentPassword.length === 0) ||
                                (form !== "remove" &&
                                    password.length < MIN_PASSWORD_LENGTH)
                            }
                            data-testid="snapshot-lock-submit"
                        >
                            {busy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : null}
                            {t(
                                form === "remove"
                                    ? "externalImport.lockRemoveConfirm"
                                    : "externalImport.lockSaveCta"
                            )}
                        </button>
                        <button
                            type="button"
                            className={secondaryButtonClass}
                            onClick={reset}
                            disabled={busy}
                            data-testid="snapshot-lock-cancel"
                        >
                            {t("externalImport.lockCancel")}
                        </button>
                    </div>
                </form>
            ) : null}
        </section>
    );
}

/**
 * What locking this snapshot would do to the account's memories (§7.1).
 *
 * Separate from the import copy on purpose: the `externalImport` namespace is
 * held to a guard that forbids memory vocabulary, and this sentence is about
 * memory. Renders nothing when there is nothing to say, so the common path is
 * not carrying a "0 memories" line.
 */
function SourceLockNotice({ impact }: { impact: SourceLockImpactView | null }) {
    const { t } = useLanguage();
    if (!impact || (impact.blockedCount === 0 && impact.backedCount === 0)) {
        return null;
    }
    return (
        <div
            className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            data-testid="source-lock-memory-notice"
        >
            {impact.blockedCount > 0 ? (
                <p data-testid="source-lock-blocked">
                    {interpolate(t("memoryReview.sourceLockBlocked"), {
                        count: impact.blockedCount,
                    })}
                </p>
            ) : null}
            {impact.backedCount > 0 ? (
                <p className="mt-2" data-testid="source-lock-backed">
                    {interpolate(t("memoryReview.sourceLockBacked"), {
                        count: impact.backedCount,
                    })}
                </p>
            ) : null}
        </div>
    );
}
