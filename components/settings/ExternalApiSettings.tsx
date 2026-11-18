"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, KeyRound } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import { useSettingsReturnProduct } from "@/components/settings/useSettingsReturnProduct";
import { SETTINGS_HOME_PATH, SETTINGS_TAB_QUERY_PARAM, settingsHrefForProduct } from "@/lib/settingsNavigation";

/**
 * Settings > API keys. Issues, lists, limits and revokes the account's
 * external API keys, and shows the client configuration generated from the
 * models this account can actually run. A new key's secret is held only in
 * this component's state until the person dismisses it.
 */

type KeySummary = {
    id: string;
    name: string;
    keyPrefix: string;
    creditCap: number | null;
    committedCredits: number;
    heldCredits: number;
    requestCount: number;
    state: "active" | "expired" | "revoked";
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
};

type ModelSummary = {
    id: string;
    name: string;
    vision: boolean;
    tools: boolean;
    contextWindowTokens: number;
    maxOutputTokens: number;
    creditWeight: number;
};

type Overview =
    | { enabled: false; keys?: KeySummary[] }
    | {
          enabled: true;
          baseUrl: string;
          limits: { maxKeys: number; maxCreditCap: number; expiryDays: number[] };
          models: ModelSummary[];
          keys: KeySummary[];
          clientConfig: { aside: unknown; vscode: unknown };
      };

type RequestRow = {
    requestId: string;
    modelId: string;
    createdAt: string;
    status: string;
    outcome: string | null;
    heldCredits: number;
    chargedCredits: number | null;
    usage: { inputTokens: number; outputTokens: number } | null;
    errorCode: string | null;
};

const fill = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

const readJson = async (response: Response) => {
    // Always consume the body, on every path (lib/apiCacheControlPolicy.ts).
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
};

function CopyBlock({ label, value, testId }: { label: string; value: string; testId: string }) {
    const { t } = useLanguage();
    const [copied, setCopied] = useState(false);
    return (
        <div className="mt-3">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-zinc-500">{label}</span>
                <button
                    type="button"
                    data-testid={`${testId}-copy`}
                    onClick={() => {
                        // A denied clipboard permission leaves the button as it was;
                        // the value stays on screen to copy by hand.
                        void navigator.clipboard
                            ?.writeText(value)
                            .then(() => {
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            })
                            .catch(() => undefined);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                    {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                    {copied ? t("externalApi.copied") : t("externalApi.copy")}
                </button>
            </div>
            <pre
                data-testid={testId}
                className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-zinc-900 p-3 text-xs leading-5 text-zinc-100"
            >
                {value}
            </pre>
        </div>
    );
}

function KeyUsage({ keyId }: { keyId: string }) {
    const { t } = useLanguage();
    const [rows, setRows] = useState<RequestRow[] | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        void fetch(`/api/user/api-keys/${encodeURIComponent(keyId)}`, { cache: "no-store" })
            .then(async (response) => {
                const body = await readJson(response);
                if (cancelled) return;
                if (!response.ok) setFailed(true);
                else setRows(body?.requests ?? []);
            })
            .catch(() => !cancelled && setFailed(true));
        return () => {
            cancelled = true;
        };
    }, [keyId]);
    if (failed) return <p className="mt-2 text-xs text-red-600">{t("externalApi.errorGeneric")}</p>;
    if (!rows) return <p className="mt-2 text-xs text-zinc-500">{t("externalApi.loading")}</p>;
    if (rows.length === 0) return <p className="mt-2 text-xs text-zinc-500">{t("externalApi.usageEmpty")}</p>;
    return (
        <ul className="mt-2 divide-y divide-zinc-200 text-xs dark:divide-zinc-800" data-testid="external-api-key-usage">
            {rows.map((row) => (
                <li key={row.requestId} className="py-2">
                    <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-semibold">{row.modelId}</span>
                        <span className="text-zinc-500">{new Date(row.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-zinc-500">
                        {row.status === "held" ? (
                            <span>{t("externalApi.usageHeld")}</span>
                        ) : (
                            <>
                                <span>{fill(t("externalApi.usageCredits"), { credits: row.chargedCredits ?? 0 })}</span>
                                {row.usage ? (
                                    <span>{fill(t("externalApi.usageTokens"), { input: row.usage.inputTokens, output: row.usage.outputTokens })}</span>
                                ) : null}
                                {row.outcome && row.outcome !== "completed" ? <span>{row.outcome}</span> : null}
                            </>
                        )}
                        <span className="font-mono">
                            {t("externalApi.requestId")}: {row.requestId}
                        </span>
                    </div>
                </li>
            ))}
        </ul>
    );
}

/**
 * A typed key limit, checked before it is sent. Only a field the person left
 * empty means "no key limit"; anything else must be a whole number in range,
 * so a stray paste or an overflowing number can never clear a limit.
 */
const parseCapDraft = (draft: string, max: number): { ok: true; value: number | null } | { ok: false } => {
    const trimmed = draft.trim();
    if (trimmed === "") return { ok: true, value: null };
    if (!/^[0-9]+$/.test(trimmed)) return { ok: false };
    const value = Number(trimmed);
    return Number.isSafeInteger(value) && value >= 1 && value <= max ? { ok: true, value } : { ok: false };
};

function KeyRow({
    entry,
    onChanged,
    revokeOnly = false,
    maxCreditCap = 0,
}: {
    entry: KeySummary;
    onChanged: () => void;
    revokeOnly?: boolean;
    maxCreditCap?: number;
}) {
    const { t } = useLanguage();
    const [editing, setEditing] = useState<"name" | "cap" | null>(null);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [showUsage, setShowUsage] = useState(false);
    const active = entry.state === "active" && !revokeOnly;

    const patch = async (payload: Record<string, unknown>) => {
        setError(null);
        const response = await fetch(`/api/user/api-keys/${encodeURIComponent(entry.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const body = await readJson(response);
        if (!response.ok) {
            setError(body?.error ?? t("externalApi.errorGeneric"));
            return;
        }
        setEditing(null);
        onChanged();
    };
    const revoke = async () => {
        if (!window.confirm(fill(t("externalApi.revokeConfirm"), { name: entry.name }))) return;
        const response = await fetch(`/api/user/api-keys/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
        await readJson(response);
        if (!response.ok) setError(t("externalApi.errorGeneric"));
        onChanged();
    };
    const stateLabel =
        entry.state === "active"
            ? t("externalApi.stateActive")
            : entry.state === "expired"
              ? t("externalApi.stateExpired")
              : t("externalApi.stateRevoked");

    return (
        <li className="py-4" data-testid="external-api-key" data-key-state={entry.state}>
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{entry.name}</p>
                    <p className="font-mono text-xs text-zinc-500">{entry.keyPrefix}_…</p>
                </div>
                <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        active
                            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                            : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                >
                    {stateLabel}
                </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
                {entry.creditCap !== null
                    ? fill(t("externalApi.capUsage"), { used: entry.committedCredits, cap: entry.creditCap })
                    : fill(t("externalApi.noCap"), { used: entry.committedCredits })}
                {entry.heldCredits > 0 ? ` · ${fill(t("externalApi.held"), { held: entry.heldCredits })}` : ""}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
                {fill(t("externalApi.createdAt"), { date: new Date(entry.createdAt).toLocaleDateString() })}
                {" · "}
                {entry.lastUsedAt
                    ? fill(t("externalApi.lastUsed"), { date: new Date(entry.lastUsedAt).toLocaleString() })
                    : t("externalApi.neverUsed")}
                {entry.expiresAt
                    ? ` · ${fill(t("externalApi.expiresAt"), { date: new Date(entry.expiresAt).toLocaleDateString() })}`
                    : ""}
            </p>

            {editing ? (
                <form
                    className="mt-2 flex flex-wrap gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (editing === "name") void patch({ name: draft });
                        else {
                            const parsed = parseCapDraft(draft, maxCreditCap);
                            if (parsed.ok) void patch({ creditCap: parsed.value });
                            else setError(fill(t("externalApi.capInvalid"), { max: maxCreditCap }));
                        }
                    }}
                >
                    <input
                        autoFocus
                        aria-label={editing === "name" ? t("externalApi.nameLabel") : t("externalApi.capLabel")}
                        inputMode={editing === "cap" ? "numeric" : undefined}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                    />
                    <button type="submit" className="rounded-lg bg-zinc-900 px-3 py-1 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
                        {t("externalApi.save")}
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-1 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                        {t("externalApi.cancel")}
                    </button>
                </form>
            ) : (
                <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
                    {active ? (
                        <>
                            <button type="button" onClick={() => { setDraft(entry.name); setEditing("name"); }} className="rounded-lg px-2 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
                                {t("externalApi.rename")}
                            </button>
                            <button type="button" onClick={() => { setDraft(entry.creditCap?.toString() ?? ""); setEditing("cap"); }} className="rounded-lg px-2 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
                                {t("externalApi.changeCap")}
                            </button>
                        </>
                    ) : null}
                    {revokeOnly ? null : <button type="button" onClick={() => setShowUsage((value) => !value)} className="rounded-lg px-2 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
                        {showUsage ? t("externalApi.usageHide") : t("externalApi.usageShow")}
                    </button>}
                    {entry.state !== "revoked" ? (
                        <button type="button" data-testid="external-api-key-revoke" onClick={() => void revoke()} className="rounded-lg px-2 py-1 text-red-600 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                            {t("externalApi.revoke")}
                        </button>
                    ) : null}
                </div>
            )}
            {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
            {showUsage ? <KeyUsage keyId={entry.id} /> : null}
        </li>
    );
}

export function ExternalApiSettings() {
    const { t } = useLanguage();
    const product = useSettingsReturnProduct();
    const [overview, setOverview] = useState<Overview | null>(null);
    const [failed, setFailed] = useState(false);
    const [name, setName] = useState("");
    const [cap, setCap] = useState("");
    const [expiry, setExpiry] = useState<string>("90");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const [created, setCreated] = useState<{ key: string; aside: unknown; vscode: unknown } | null>(null);

    const [version, setVersion] = useState(0);
    const load = useCallback(() => setVersion((value) => value + 1), []);
    useEffect(() => {
        let cancelled = false;
        void fetch("/api/user/api-keys", { cache: "no-store" })
            .then(async (response) => {
                const body = await readJson(response);
                if (cancelled) return;
                if (!response.ok || !body) {
                    setFailed(true);
                    return;
                }
                setFailed(false);
                setOverview(body as Overview);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [version]);

    const create = async () => {
        const maxCreditCap = overview?.enabled ? overview.limits.maxCreditCap : 0;
        const parsedCap = parseCapDraft(cap, maxCreditCap);
        if (!parsedCap.ok) {
            setCreateError(fill(t("externalApi.capInvalid"), { max: maxCreditCap }));
            return;
        }
        setCreating(true);
        setCreateError(null);
        try {
            const response = await fetch("/api/user/api-keys", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name,
                    creditCap: parsedCap.value,
                    expiresInDays: expiry === "never" ? null : Number(expiry),
                }),
            });
            const body = await readJson(response);
            if (!response.ok || !body?.key) {
                setCreateError(body?.error ?? t("externalApi.errorGeneric"));
                return;
            }
            setCreated({ key: body.key, aside: body.clientConfig.aside, vscode: body.clientConfig.vscode });
            setName("");
            setCap("");
            load();
        } finally {
            setCreating(false);
        }
    };

    return (
        <div className="mx-auto w-full max-w-2xl px-6 py-10" data-testid="external-api-settings">
            <SettingsDetailNav section="api-keys" currentLabel={t("externalApi.pageTitle")} backTestId="external-api-back" />
            <h1 className="mt-6 flex items-center gap-2 text-2xl font-black">
                <KeyRound className="h-6 w-6" aria-hidden="true" />
                {t("externalApi.pageTitle")}
            </h1>
            <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{t("externalApi.intro")}</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{t("externalApi.shareWarning")}</p>

            {failed && !overview ? <p className="mt-8 text-sm text-zinc-600 dark:text-zinc-300">{t("externalApi.loadFailed")}</p> : null}
            {!failed && !overview ? <p className="mt-8 text-sm text-zinc-500">{t("externalApi.loading")}</p> : null}
            {overview && !overview.enabled ? (
                <>
                    <p className="mt-8 rounded-2xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950/60" data-testid="external-api-unavailable">
                        {t("externalApi.unavailable")}
                    </p>
                    {overview.keys?.length ? (
                        // Still listed so a key issued earlier can be revoked.
                        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                            <h2 className="text-base font-bold">{t("externalApi.keysTitle")}</h2>
                            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="external-api-keys">
                                {overview.keys.map((entry) => (
                                    <KeyRow key={entry.id} entry={entry} onChanged={() => void load()} revokeOnly />
                                ))}
                            </ul>
                        </section>
                    ) : null}
                </>
            ) : null}

            {overview && overview.enabled ? (
                <>
                    {created ? (
                        <section className="mt-8 rounded-2xl border-2 border-zinc-900 bg-white p-4 dark:border-zinc-100 dark:bg-zinc-950" data-testid="external-api-created">
                            <h2 className="text-base font-bold">{t("externalApi.createdTitle")}</h2>
                            <p className="mt-1 text-sm text-zinc-500">{t("externalApi.createdBody")}</p>
                            <CopyBlock label="API key" value={created.key} testId="external-api-created-key" />
                            <CopyBlock label={`${t("externalApi.asideTitle")} — ${t("externalApi.asideHint")}`} value={JSON.stringify(created.aside, null, 2)} testId="external-api-created-aside" />
                            <CopyBlock label={`${t("externalApi.vscodeTitle")} — ${t("externalApi.vscodeHint")}`} value={JSON.stringify(created.vscode, null, 2)} testId="external-api-created-vscode" />
                            <button type="button" data-testid="external-api-created-done" onClick={() => setCreated(null)} className="mt-4 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
                                {t("externalApi.done")}
                            </button>
                        </section>
                    ) : null}

                    <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                        <h2 className="text-base font-bold">{t("externalApi.createTitle")}</h2>
                        <form
                            className="mt-3 grid gap-3"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void create();
                            }}
                        >
                            <label className="grid gap-1 text-sm">
                                <span className="font-semibold">{t("externalApi.nameLabel")}</span>
                                <input data-testid="external-api-name" required maxLength={80} value={name} placeholder={t("externalApi.namePlaceholder")} onChange={(event) => setName(event.target.value)} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900" />
                            </label>
                            <label className="grid gap-1 text-sm">
                                <span className="font-semibold">{t("externalApi.capLabel")}</span>
                                <input data-testid="external-api-cap" inputMode="numeric" value={cap} onChange={(event) => setCap(event.target.value)} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900" />
                                <span className="text-xs text-zinc-500">{t("externalApi.capHint")}</span>
                            </label>
                            <label className="grid gap-1 text-sm">
                                <span className="font-semibold">{t("externalApi.expiryLabel")}</span>
                                <select data-testid="external-api-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value)} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
                                    {overview.limits.expiryDays.map((days) => (
                                        <option key={days} value={String(days)}>
                                            {fill(t("externalApi.expiryDays"), { days })}
                                        </option>
                                    ))}
                                    <option value="never">{t("externalApi.expiryNever")}</option>
                                </select>
                            </label>
                            {createError ? <p className="text-sm text-red-600">{createError}</p> : null}
                            <button type="submit" data-testid="external-api-create" disabled={creating || !name.trim()} className="justify-self-start rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
                                {creating ? t("externalApi.creating") : t("externalApi.createButton")}
                            </button>
                        </form>
                    </section>

                    <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                        <h2 className="text-base font-bold">{t("externalApi.keysTitle")}</h2>
                        {overview.keys.length === 0 ? (
                            <p className="mt-2 text-sm text-zinc-500">{t("externalApi.noKeys")}</p>
                        ) : (
                            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="external-api-keys">
                                {overview.keys.map((entry) => (
                                    <KeyRow key={entry.id} entry={entry} onChanged={() => void load()} maxCreditCap={overview.limits.maxCreditCap} />
                                ))}
                            </ul>
                        )}
                        <Link href={settingsHrefForProduct(`${SETTINGS_HOME_PATH}?${SETTINGS_TAB_QUERY_PARAM}=plan`, product)} className="mt-3 inline-block text-sm font-semibold text-blue-600 hover:underline dark:text-blue-400">
                            {t("externalApi.accountUsageLink")}
                        </Link>
                    </section>

                    <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                        <h2 className="text-base font-bold">{t("externalApi.modelsTitle")}</h2>
                        {overview.models.length === 0 ? (
                            <p className="mt-2 text-sm text-zinc-500">{t("externalApi.noModels")}</p>
                        ) : (
                            <ul className="mt-2 grid gap-2 text-sm" data-testid="external-api-models">
                                {overview.models.map((model) => (
                                    <li key={model.id} className="rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
                                        <span className="font-semibold">{model.name}</span>{" "}
                                        <span className="font-mono text-xs text-zinc-500">{model.id}</span>
                                        <span className="block text-xs text-zinc-500">
                                            {model.vision ? t("externalApi.inputTextImage") : t("externalApi.inputText")} · {t("externalApi.toolCalls")} ·{" "}
                                            {fill(t("externalApi.creditsPerRequest"), { credits: model.creditWeight })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <CopyBlock label={t("externalApi.baseUrlLabel")} value={overview.baseUrl} testId="external-api-base-url" />
                        <CopyBlock label={`${t("externalApi.asideTitle")} — ${t("externalApi.asideHint")}`} value={JSON.stringify(overview.clientConfig.aside, null, 2)} testId="external-api-aside-config" />
                        <CopyBlock label={`${t("externalApi.vscodeTitle")} — ${t("externalApi.vscodeHint")}`} value={JSON.stringify(overview.clientConfig.vscode, null, 2)} testId="external-api-vscode-config" />
                    </section>
                </>
            ) : null}
        </div>
    );
}
