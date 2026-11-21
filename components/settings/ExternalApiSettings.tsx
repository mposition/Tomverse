"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, Copy, KeyRound } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import { useSettingsReturnProduct } from "@/components/settings/useSettingsReturnProduct";
import { SETTINGS_HOME_PATH, SETTINGS_TAB_QUERY_PARAM, settingsHrefForProduct } from "@/lib/settingsNavigation";
import {
    asideProviderConfig,
    KEY_PLACEHOLDER,
    SMART_ADAPTIVE_MODEL_ID,
    vscodeCustomEndpointConfig,
    type ExternalApiModelCapabilities,
} from "@/lib/externalApiCatalogCore";
import { claudeCodeConfig, codexConfig, codingToolModels, cursorConfig } from "@/lib/externalApiCodingTools";

/**
 * Settings > API keys. Lists, limits and revokes the account's external API
 * keys; a new key is made in a dialog and its secret shown once in another.
 * "Connect a tool" shows one tool's setup at a time, built from the models
 * this account can run, and "Models allowed through the API" is searchable,
 * so the page stays short however many tools and models there are. A new
 * key's secret is held only in this component's state, never stored.
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

type ModelSummary = ExternalApiModelCapabilities;

/** Install and connect lines for the Tomverse CLI; absent until the package is published. */
type TomverseCliGuide = { install: string; powershell: string; posix: string };

type Overview =
    // `plan_not_eligible`: a Free account; the API needs a paid plan.
    | { enabled: false; reason?: "plan_not_eligible"; keys?: KeySummary[] }
    | {
          enabled: true;
          /** The general API: Aside, VS Code and other apps. */
          baseUrl: string;
          /** The coding API: Claude Code, Codex, Cursor and the tomverse CLI. */
          codingBaseUrl?: string;
          limits: { maxKeys: number; maxCreditCap: number; expiryDays: number[] };
          models: ModelSummary[];
          codingModels?: ModelSummary[];
          keys: KeySummary[];
          tomverseCli?: TomverseCliGuide | null;
      };

type RequestRow = {
    requestId: string;
    modelId: string;
    protocol?: string;
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

const PROTOCOL_LABEL: Record<string, string> = {
    chat_completions: "Chat Completions",
    anthropic_messages: "Anthropic Messages",
    responses: "Responses",
};

function ToolModelSelect({
    models,
    value,
    onChange,
    testId,
}: {
    models: ModelSummary[];
    value: string | undefined;
    onChange: (id: string) => void;
    testId: string;
}) {
    const { t } = useLanguage();
    return (
        <label className="mt-3 grid gap-1 text-sm">
            <span className="font-semibold">{t("externalApi.codingToolModel")}</span>
            <select
                data-testid={testId}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            >
                {models.map((model) => (
                    <option key={model.id} value={model.id}>
                        {model.name} ({model.id})
                    </option>
                ))}
            </select>
        </label>
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
                        <span className="font-semibold">
                            {row.modelId}
                            {row.protocol ? <span className="ml-2 font-normal text-zinc-500">{PROTOCOL_LABEL[row.protocol] ?? row.protocol}</span> : null}
                        </span>
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
    // Only a truly empty field clears the limit; whitespace alone is a mistake.
    if (draft === "") return { ok: true, value: null };
    const trimmed = draft.trim();
    if (!/^[0-9]+$/.test(trimmed)) return { ok: false };
    const value = Number(trimmed);
    return Number.isSafeInteger(value) && value >= 1 && value <= max ? { ok: true, value } : { ok: false };
};

/** Name, key, usage and last use: the columns of the key list on a wide screen. */
const KEY_COLUMNS = "sm:grid sm:grid-cols-[minmax(0,2.1fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_minmax(0,1fr)_2rem] sm:items-center sm:gap-3";

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
    const [menuOpen, setMenuOpen] = useState(false);
    const active = entry.state === "active" && !revokeOnly;

    const patch = async (payload: Record<string, unknown>) => {
        setError(null);
        const response = await fetch(`/api/user/api-keys/${encodeURIComponent(entry.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }).catch(() => null);
        if (!response) {
            setError(t("externalApi.errorGeneric"));
            return;
        }
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
        const response = await fetch(`/api/user/api-keys/${encodeURIComponent(entry.id)}`, { method: "DELETE" }).catch(() => null);
        if (!response) {
            setError(t("externalApi.errorGeneric"));
            return;
        }
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
    const usageText =
        entry.creditCap !== null
            ? fill(t("externalApi.capUsage"), { used: entry.committedCredits.toLocaleString(), cap: entry.creditCap.toLocaleString() })
            : fill(t("externalApi.noCap"), { used: entry.committedCredits.toLocaleString() });
    const usageShare = entry.creditCap ? Math.min(1, (entry.committedCredits + entry.heldCredits) / entry.creditCap) : 0;
    const lastUsed = entry.lastUsedAt
        ? new Date(entry.lastUsedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : t("externalApi.neverUsed");
    const menuItem = "block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800";
    const pick = (action: () => void) => () => {
        setMenuOpen(false);
        action();
    };

    return (
        <li
            className={`mt-2 rounded-xl border border-zinc-200 p-3 first:mt-0 dark:border-zinc-800 sm:mt-0 sm:rounded-none sm:border-x-0 sm:border-b-0 sm:px-4 sm:first:border-t-0 ${entry.state === "active" ? "" : "opacity-60"}`}
            data-testid="external-api-key"
            data-key-state={entry.state}
        >
            <div className={KEY_COLUMNS}>
                <div className="flex min-w-0 items-start justify-between gap-2 sm:block">
                    <div className="min-w-0">
                        <p className="truncate text-sm font-bold">{entry.name}</p>
                        <p className="mt-1 text-xs text-zinc-500">
                            <span
                                className={`mr-1 rounded-full px-2 py-0.5 font-semibold ${
                                    entry.state === "active"
                                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                                        : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                                }`}
                            >
                                {stateLabel}
                            </span>
                            {entry.expiresAt ? fill(t("externalApi.expiresAt"), { date: new Date(entry.expiresAt).toLocaleDateString() }) : null}
                        </p>
                    </div>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:contents">
                    <div className="sm:block">
                        <dt className="text-zinc-500 sm:sr-only">{t("externalApi.colKey")}</dt>
                        <dd className="truncate font-mono text-zinc-600 dark:text-zinc-300">{entry.keyPrefix}_…</dd>
                    </div>
                    <div className="sm:order-none sm:col-start-4 sm:row-start-1">
                        <dt className="text-zinc-500 sm:sr-only">{t("externalApi.colLastUsed")}</dt>
                        <dd className="text-zinc-600 dark:text-zinc-300">{lastUsed}</dd>
                    </div>
                    <div className="col-span-2 sm:col-span-1 sm:col-start-3 sm:row-start-1">
                        <dt className="text-zinc-500 sm:sr-only">{t("externalApi.colUsage")}</dt>
                        <dd className="text-zinc-700 dark:text-zinc-200">
                            {usageText}
                            {entry.heldCredits > 0 ? <span className="block text-zinc-500">{fill(t("externalApi.held"), { held: entry.heldCredits })}</span> : null}
                            {entry.creditCap ? (
                                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
                                    <span className="block h-full rounded-full bg-cyan-500" style={{ width: `${Math.max(2, Math.round(usageShare * 100))}%` }} />
                                </span>
                            ) : null}
                        </dd>
                    </div>
                </dl>
                <div className="relative mt-2 flex justify-end sm:col-start-5 sm:row-start-1 sm:mt-0">
                    <button
                        type="button"
                        aria-label={`${t("externalApi.keyActions")}: ${entry.name}`}
                        aria-expanded={menuOpen}
                        data-testid="external-api-key-menu"
                        onClick={() => setMenuOpen((value) => !value)}
                        className="rounded-lg px-2 py-1 text-lg leading-none text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                        ⋯
                    </button>
                    {menuOpen ? (
                        <div className="absolute right-0 top-8 z-10 w-44 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900" role="menu">
                            {active ? (
                                <>
                                    <button type="button" role="menuitem" className={menuItem} onClick={pick(() => { setDraft(entry.name); setEditing("name"); })}>
                                        {t("externalApi.rename")}
                                    </button>
                                    <button type="button" role="menuitem" className={menuItem} onClick={pick(() => { setDraft(entry.creditCap?.toString() ?? ""); setEditing("cap"); })}>
                                        {t("externalApi.changeCap")}
                                    </button>
                                </>
                            ) : null}
                            {revokeOnly ? null : (
                                <button type="button" role="menuitem" className={menuItem} onClick={pick(() => setShowUsage((value) => !value))}>
                                    {showUsage ? t("externalApi.usageHide") : t("externalApi.usageShow")}
                                </button>
                            )}
                            {entry.state !== "revoked" ? (
                                <button type="button" role="menuitem" data-testid="external-api-key-revoke" className={`${menuItem} text-red-600`} onClick={pick(() => void revoke())}>
                                    {t("externalApi.revoke")}
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>

            {editing ? (
                <form
                    className="mt-3 flex flex-wrap gap-2"
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
            ) : null}
            {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
            {showUsage ? <KeyUsage keyId={entry.id} /> : null}
        </li>
    );
}

function KeyList({ keys, onChanged, revokeOnly = false, maxCreditCap = 0 }: { keys: KeySummary[]; onChanged: () => void; revokeOnly?: boolean; maxCreditCap?: number }) {
    const { t } = useLanguage();
    return (
        <div className="mt-3 sm:overflow-visible sm:rounded-xl sm:border sm:border-zinc-200 sm:dark:border-zinc-800">
            <div className={`hidden bg-zinc-50 px-4 py-2 text-xs font-semibold text-zinc-500 dark:bg-zinc-900 sm:rounded-t-xl ${KEY_COLUMNS}`} aria-hidden="true">
                <span>{t("externalApi.colName")}</span>
                <span>{t("externalApi.colKey")}</span>
                <span>{t("externalApi.colUsage")}</span>
                <span>{t("externalApi.colLastUsed")}</span>
                <span />
            </div>
            <ul data-testid="external-api-keys">
                {keys.map((entry) => (
                    <KeyRow key={entry.id} entry={entry} onChanged={onChanged} revokeOnly={revokeOnly} maxCreditCap={maxCreditCap} />
                ))}
            </ul>
        </div>
    );
}

/** A dialog over the page; a sheet from the bottom on a narrow screen. */
function Modal({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId: string }) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                data-testid={testId}
                onClick={(event) => event.stopPropagation()}
                className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-950 sm:max-w-lg sm:rounded-2xl"
            >
                <h2 className="text-lg font-bold">{title}</h2>
                {children}
            </div>
        </div>
    );
}

/** The three values any OpenAI-compatible tool asks for. */
const genericConfig = (baseUrl: string, modelId: string, apiKey: string = KEY_PLACEHOLDER) =>
    `Base URL: ${baseUrl}
API key: ${apiKey}
Model: ${modelId}`;

/** Narrows a model list by name or id, so a long catalogue stays one screen. */
const matchesModel = (model: ModelSummary, query: string) => {
    const needle = query.trim().toLowerCase();
    return !needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle);
};

/** Rows shown before "show more" when nothing is searched. */
const MODEL_PREVIEW_COUNT = 3;

function ModelSearchList({
    models,
    picked,
    onToggle,
    toolsFor,
    testId,
}: {
    models: ModelSummary[];
    /** With `picked`, each row is a checkbox that puts the model in a configuration. */
    picked?: string[];
    onToggle?: (id: string) => void;
    /** The tools a model works with, shown under its name. */
    toolsFor?: (model: ModelSummary) => string;
    testId: string;
}) {
    const { t } = useLanguage();
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState(false);
    const matching = models.filter((model) => matchesModel(model, query));
    // Smart Adaptive's credit figure is the most a request can cost; each
    // request is charged as the model that answers it. The cheapest model it
    // can route to is the other end of that range.
    const routable = models.filter((model) => model.id !== SMART_ADAPTIVE_MODEL_ID && (model.protocols?.includes("chat_completions") ?? true));
    const smartAdaptiveFloor = routable.length ? Math.min(...routable.map((model) => model.creditWeight)) : null;
    const searching = query.trim() !== "";
    const shown = searching || expanded ? matching : matching.slice(0, MODEL_PREVIEW_COUNT);
    const hidden = matching.length - shown.length;
    return (
        <div className="mt-3">
            <input
                type="search"
                data-testid={`${testId}-search`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("externalApi.modelSearch")}
                aria-label={t("externalApi.modelSearch")}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <ul className="mt-2 grid gap-2 text-sm" data-testid={testId}>
                {shown.map((model) => {
                    const details = (
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                            <span className="min-w-0">
                                <span className="font-semibold">{model.name}</span>
                                <span className="block break-all font-mono text-xs text-zinc-500">{model.id}</span>
                                {model.id === SMART_ADAPTIVE_MODEL_ID ? (
                                    <span className="block text-xs text-zinc-600 dark:text-zinc-300">{t("externalApi.smartAdaptiveHint")}</span>
                                ) : toolsFor ? (
                                    <span className="block text-xs text-zinc-500">{toolsFor(model)}</span>
                                ) : null}
                            </span>
                            <span className="self-start shrink-0 rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 dark:border-zinc-700">
                                {model.vision ? t("externalApi.inputTextImage") : t("externalApi.inputText")} · {model.id === SMART_ADAPTIVE_MODEL_ID && smartAdaptiveFloor !== null && smartAdaptiveFloor < model.creditWeight
                                    ? fill(t("externalApi.creditsRange"), { min: smartAdaptiveFloor, max: model.creditWeight })
                                    : fill(t("externalApi.creditsPerRequest"), { credits: model.creditWeight })}
                            </span>
                        </span>
                    );
                    return (
                        <li key={model.id} className="rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
                            {picked && onToggle ? (
                                <label className="flex items-start gap-3">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={picked.includes(model.id)}
                                        onChange={() => onToggle(model.id)}
                                        aria-label={`${t("externalApi.includeInConfig")}: ${model.name}`}
                                        data-testid={`external-api-pick-${model.id}`}
                                    />
                                    {details}
                                </label>
                            ) : (
                                details
                            )}
                        </li>
                    );
                })}
                {matching.length === 0 ? <li className="px-3 py-2 text-xs text-zinc-500">{t("externalApi.modelSearchEmpty")}</li> : null}
            </ul>
            {hidden > 0 ? (
                <button type="button" data-testid={`${testId}-more`} onClick={() => setExpanded(true)} className="mt-2 text-sm font-semibold text-blue-600 hover:underline dark:text-blue-400">
                    {fill(t("externalApi.modelsMore"), { count: hidden })}
                </button>
            ) : null}
        </div>
    );
}

function Segmented<T extends string>({ options, value, onChange, testId }: { options: [T, string][]; value: T; onChange: (value: T) => void; testId: string }) {
    return (
        <div className="inline-flex rounded-lg border border-zinc-300 p-0.5 text-xs dark:border-zinc-700" role="group">
            {options.map(([id, label]) => (
                <button
                    key={id}
                    type="button"
                    aria-pressed={value === id}
                    data-testid={`${testId}-${id}`}
                    onClick={() => onChange(id)}
                    className={`rounded-md px-2.5 py-1 font-semibold ${value === id ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-300"}`}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

function Notes({ children }: { children: ReactNode }) {
    const { t } = useLanguage();
    return (
        <details className="mt-3 rounded-xl border border-zinc-200 px-3 py-2 text-xs leading-5 text-zinc-500 dark:border-zinc-800">
            <summary className="cursor-pointer font-semibold text-zinc-700 dark:text-zinc-200">{t("externalApi.notesTitle")}</summary>
            <div className="mt-2 grid gap-2">{children}</div>
        </details>
    );
}

type Platform = "tomverse-cli" | "claude-code" | "codex" | "cursor" | "aside" | "vscode" | "other";
const PLATFORMS: Platform[] = ["tomverse-cli", "claude-code", "codex", "cursor", "aside", "vscode", "other"];
type Shell = "powershell" | "posix";
type Surface = "terminal" | "extension";
const SHELLS: [Shell, string][] = [
    ["powershell", "Windows (PowerShell)"],
    ["posix", "macOS / Linux"],
];

/**
 * One tool at a time: the person picks where the key is used and sees only
 * that tool's setup. Configurations carry the new key while this page holds
 * it and a placeholder otherwise. Claude Code and Codex offer Smart Adaptive
 * scoped to their own provider's models (codingToolModels). The coding tools
 * -- Claude Code, Codex, Cursor, the tomverse CLI and VS Code (Copilot Chat's
 * custom endpoint) -- use the coding API's address and models; Aside and other
 * OpenAI-compatible apps the general API's (owner decision 2026-11-21).
 */
function ConnectSection({
    baseUrl,
    models,
    codingBaseUrl,
    codingModels,
    apiKey,
    tomverseCli,
}: {
    baseUrl: string;
    models: ModelSummary[];
    codingBaseUrl: string;
    codingModels: ModelSummary[];
    apiKey: string | null;
    tomverseCli?: TomverseCliGuide | null;
}) {
    const { t } = useLanguage();
    const key = apiKey ?? KEY_PLACEHOLDER;
    const [platform, setPlatform] = useState<Platform | null>(null);
    const [shell, setShell] = useState<Shell>("powershell");
    const [surface, setSurface] = useState<Surface>("terminal");
    const lists = useMemo(() => codingToolModels(codingModels), [codingModels]);
    const [claudeId, setClaudeId] = useState<string | undefined>();
    const [codexId, setCodexId] = useState<string | undefined>();
    const [cursorId, setCursorId] = useState<string | undefined>();
    const [otherId, setOtherId] = useState<string | undefined>();
    // Aside and VS Code take a model list: Smart Adaptive alone until the
    // person ticks more, because its id survives catalogue changes.
    const [picked, setPicked] = useState<string[] | null>(null);
    const pickedIds =
        picked ?? (models.some((model) => model.id === SMART_ADAPTIVE_MODEL_ID) ? [SMART_ADAPTIVE_MODEL_ID] : models.map((model) => model.id));
    const pickedModels = models.filter((model) => pickedIds.includes(model.id));
    // VS Code is a coding tool: it lists the coding API's models, never an empty list.
    const pickedCodingModels = (() => {
        const chosen = codingModels.filter((model) => pickedIds.includes(model.id));
        if (chosen.length) return chosen;
        const fallback = codingModels.find((model) => model.id === SMART_ADAPTIVE_MODEL_ID) ?? codingModels[0];
        return fallback ? [fallback] : [];
    })();
    const togglePicked = (id: string) => {
        if (!pickedIds.includes(id)) setPicked([...pickedIds, id]);
        // Keep at least one model, so a copied configuration is never empty.
        else if (pickedIds.length > 1) setPicked(pickedIds.filter((value) => value !== id));
    };

    const surfaces: [Surface, string][] = [
        ["terminal", t("externalApi.terminal")],
        ["extension", t("externalApi.vscodeExtension")],
    ];
    const platformName = (id: Platform) =>
        ({ "tomverse-cli": "Tomverse CLI", "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", aside: "Aside", vscode: "VS Code", other: t("externalApi.platformOther") })[id];
    const platformHint = (id: Platform) =>
        ({
            "tomverse-cli": t("externalApi.terminal"),
            "claude-code": `${t("externalApi.terminal")} · ${t("externalApi.vscodeExtension")}`,
            codex: `${t("externalApi.terminal")} · ${t("externalApi.vscodeExtension")}`,
            cursor: "Chat · Agent",
            aside: "Custom Provider",
            vscode: t("externalApi.vscodeChip"),
            other: t("externalApi.otherChip"),
        })[id];
    const noModels = <p className="mt-3 text-xs text-zinc-500">{t("externalApi.codingToolNoModels")}</p>;

    const panel = (() => {
        switch (platform) {
            case "tomverse-cli":
                if (!tomverseCli) return null;
                return (
                    <div data-testid="external-api-tool-tomverse-cli">
                        <p className="text-xs text-zinc-500">{t("externalApi.tomverseCliHint")}</p>
                        <CopyBlock label={t("externalApi.tomverseCliInstall")} value={tomverseCli.install} testId="external-api-tomverse-cli-install" />
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Segmented options={SHELLS} value={shell} onChange={setShell} testId="external-api-shell" />
                        </div>
                        <CopyBlock
                            label={t("externalApi.tomverseCliConnect")}
                            value={(shell === "powershell" ? tomverseCli.powershell : tomverseCli.posix).replace(KEY_PLACEHOLDER, key)}
                            testId={`external-api-tomverse-cli-${shell}`}
                        />
                        <Notes>
                            <p>{t("externalApi.tomverseCliNotes")}</p>
                        </Notes>
                    </div>
                );
            case "claude-code": {
                const claude = lists.claudeCode.find((model) => model.id === claudeId) ?? lists.claudeCode[0];
                if (!claude) return noModels;
                const config = claudeCodeConfig(codingBaseUrl, claude, lists.claudeCode, key);
                return (
                    <div data-testid="external-api-tool-claude-code">
                        <p className="text-xs text-zinc-500">{t("externalApi.claudeCodeHint")}</p>
                        <ToolModelSelect models={lists.claudeCode} value={claude.id} onChange={setClaudeId} testId="external-api-claude-code-model" />
                        {claude.id === SMART_ADAPTIVE_MODEL_ID ? <p className="mt-1 text-xs text-zinc-500" data-testid="external-api-native-smart-hint">{t("externalApi.nativeSmartAdaptiveHint")}</p> : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Segmented options={surfaces} value={surface} onChange={setSurface} testId="external-api-surface" />
                            {surface === "terminal" ? <Segmented options={SHELLS} value={shell} onChange={setShell} testId="external-api-shell" /> : null}
                        </div>
                        {surface === "extension" ? (
                            <CopyBlock label={t("externalApi.claudeCodeVscode")} value={config.vscodeSettings} testId="external-api-claude-code-vscode" />
                        ) : shell === "powershell" ? (
                            <CopyBlock label={t("externalApi.claudeCodeTerminal")} value={config.powershell} testId="external-api-claude-code-powershell" />
                        ) : (
                            <CopyBlock label={t("externalApi.claudeCodeTerminal")} value={config.posix} testId="external-api-claude-code-posix" />
                        )}
                        <Notes>
                            <p>{t("externalApi.codingToolsIntro")}</p>
                            <p>{t("externalApi.claudeCodeNotes")}</p>
                            <p>{t("externalApi.codingToolsVerified")}</p>
                        </Notes>
                    </div>
                );
            }
            case "codex": {
                const codex = lists.codex.find((model) => model.id === codexId) ?? lists.codex[0];
                if (!codex) return noModels;
                const files = codexConfig(codingBaseUrl, codex, lists.codex);
                const withKey = (text: string) => text.replace(KEY_PLACEHOLDER, key);
                return (
                    <div data-testid="external-api-tool-codex">
                        <p className="text-xs text-zinc-500">{t("externalApi.codexHint")}</p>
                        <ToolModelSelect models={lists.codex} value={codex.id} onChange={setCodexId} testId="external-api-codex-model" />
                        {codex.id === SMART_ADAPTIVE_MODEL_ID ? <p className="mt-1 text-xs text-zinc-500" data-testid="external-api-native-smart-hint">{t("externalApi.nativeSmartAdaptiveHint")}</p> : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Segmented options={surfaces} value={surface} onChange={setSurface} testId="external-api-surface" />
                            <Segmented options={SHELLS} value={shell} onChange={setShell} testId="external-api-shell" />
                        </div>
                        {surface === "terminal" ? (
                            <>
                                <CopyBlock label={t("externalApi.codexProvider")} value={files.providerToml} testId="external-api-codex-provider" />
                                <CopyBlock label={t("externalApi.codexProfile")} value={files.profileToml} testId="external-api-codex-profile" />
                            </>
                        ) : (
                            <CopyBlock label={t("externalApi.codexDefault")} value={files.defaultToml} testId="external-api-codex-default" />
                        )}
                        <CopyBlock
                            label={t("externalApi.codexKey")}
                            value={withKey(shell === "powershell" ? files.powershellKey : files.posixKey)}
                            testId={`external-api-codex-key-${shell}`}
                        />
                        <Notes>
                            <p>{t("externalApi.codingToolsIntro")}</p>
                            <p>{t("externalApi.codexNotes")}</p>
                            <p>{t("externalApi.codingToolsVerified")}</p>
                        </Notes>
                    </div>
                );
            }
            case "cursor": {
                const cursor = lists.cursor.find((model) => model.id === cursorId) ?? lists.cursor[0];
                if (!cursor) return noModels;
                return (
                    <div data-testid="external-api-tool-cursor">
                        <p className="text-xs text-zinc-500">{t("externalApi.cursorHint")}</p>
                        <p className="mt-1 text-xs font-semibold text-zinc-600 dark:text-zinc-300" data-testid="external-api-cursor-models">{t("externalApi.cursorModels")}</p>
                        <ToolModelSelect models={lists.cursor} value={cursor.id} onChange={setCursorId} testId="external-api-cursor-model" />
                        <CopyBlock label="Cursor Settings › Models" value={cursorConfig(codingBaseUrl, cursor, key)} testId="external-api-cursor-config" />
                        <Notes>
                            <p>{t("externalApi.codingToolsIntro")}</p>
                            <p>{t("externalApi.cursorNotes")}</p>
                        </Notes>
                    </div>
                );
            }
            case "aside":
            case "vscode":
                return (
                    <div data-testid={`external-api-tool-${platform}`}>
                        <p className="text-xs text-zinc-500">{platform === "aside" ? t("externalApi.asideHint") : t("externalApi.vscodeHint")}</p>
                        <p className="mt-3 text-sm font-semibold">{t("externalApi.modelsPick")}</p>
                        <ModelSearchList models={platform === "aside" ? models : codingModels} picked={pickedIds} onToggle={togglePicked} testId="external-api-pick-models" />
                        {platform === "aside" ? (
                            <CopyBlock label="Aside" value={JSON.stringify(asideProviderConfig(baseUrl, pickedModels, key), null, 2)} testId="external-api-aside-config" />
                        ) : (
                            // VS Code asks for the key itself and stores it securely.
                            <CopyBlock label="VS Code" value={JSON.stringify(vscodeCustomEndpointConfig(codingBaseUrl, pickedCodingModels), null, 2)} testId="external-api-vscode-config" />
                        )}
                    </div>
                );
            case "other": {
                const other = models.find((model) => model.id === otherId) ?? models.find((model) => model.id === SMART_ADAPTIVE_MODEL_ID) ?? models[0];
                return (
                    <div data-testid="external-api-tool-other">
                        <p className="text-xs text-zinc-500">{t("externalApi.genericHint")}</p>
                        {other ? <ToolModelSelect models={models} value={other.id} onChange={setOtherId} testId="external-api-other-model" /> : null}
                        <CopyBlock label={t("externalApi.genericTitle")} value={genericConfig(baseUrl, other?.id ?? SMART_ADAPTIVE_MODEL_ID, key)} testId="external-api-generic-config" />
                    </div>
                );
            }
            default:
                return null;
        }
    })();

    return (
        <section id="connect" className="mt-6 scroll-mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60" data-testid="external-api-connect">
            <h2 className="text-base font-bold">{t("externalApi.connectTitle")}</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">{t("externalApi.connectIntro")}</p>
            {apiKey ? (
                <p className="mt-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400" data-testid="external-api-key-filled">
                    ✓ {t("externalApi.keyFilledIn")}
                </p>
            ) : null}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label={t("externalApi.connectTitle")}>
                {PLATFORMS.filter((id) => id !== "tomverse-cli" || tomverseCli).map((id) => (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={platform === id}
                        data-testid={`external-api-platform-${id}`}
                        onClick={() => setPlatform(id)}
                        className={`rounded-xl border p-3 text-left ${
                            platform === id
                                ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900 dark:border-zinc-100 dark:bg-zinc-900 dark:ring-zinc-100"
                                : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                        }`}
                    >
                        <span className="block text-sm font-bold">{platformName(id)}</span>
                        <span className="mt-0.5 hidden text-xs text-zinc-500 sm:block">{platformHint(id)}</span>
                    </button>
                ))}
            </div>
            {platform ? (
                <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                    <h3 className="mb-1 text-base font-bold">{platformName(platform)}</h3>
                    {panel}
                </div>
            ) : null}
        </section>
    );
}

/**
 * Which tools can use a model, from the protocols it carries and the API that
 * offers it: the coding tools (VS Code among them) through the coding API,
 * Aside and other apps through the general one.
 */
const toolsForModel = (model: ModelSummary, otherLabel: string, offeredOn: { general: boolean; coding: boolean }) => {
    const lists = offeredOn.coding ? codingToolModels([model]) : { claudeCode: [], codex: [], cursor: [] };
    const chatCompletions = model.protocols?.includes("chat_completions") ?? true;
    return [
        lists.claudeCode.length ? "Claude Code" : null,
        lists.codex.length ? "Codex" : null,
        lists.cursor.length ? "Cursor" : null,
        offeredOn.coding && chatCompletions ? "VS Code" : null,
        ...(offeredOn.general && chatCompletions ? ["Aside", otherLabel] : []),
    ]
        .filter(Boolean)
        .join(" · ");
};

/** Every model either API offers, the general API's first. */
const listedModels = (overview: Extract<Overview, { enabled: true }>) => {
    const general = new Set(overview.models.map((model) => model.id));
    return [...overview.models, ...(overview.codingModels ?? []).filter((model) => !general.has(model.id))];
};

export function ExternalApiSettings() {
    const { t } = useLanguage();
    const product = useSettingsReturnProduct();
    const [overview, setOverview] = useState<Overview | null>(null);
    const [failed, setFailed] = useState(false);
    const [signedOut, setSignedOut] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState("");
    const [cap, setCap] = useState("");
    const [expiry, setExpiry] = useState<string>("90");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    // The new key's secret, held only in this component: shown once in its
    // dialog, then filled into the tool setup until the person leaves the page.
    const [newKey, setNewKey] = useState<string | null>(null);
    const [keyDialogOpen, setKeyDialogOpen] = useState(false);

    const [version, setVersion] = useState(0);
    const load = useCallback(() => setVersion((value) => value + 1), []);
    useEffect(() => {
        let cancelled = false;
        void fetch("/api/user/api-keys", { cache: "no-store" })
            .then(async (response) => {
                const body = await readJson(response);
                if (cancelled) return;
                // The list is the session probe: no session is a sign-in
                // prompt, not a load failure.
                setSignedOut(response.status === 401);
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

    const closeCreate = useCallback(() => {
        setCreateOpen(false);
        setCreateError(null);
    }, []);
    const closeKeyDialog = useCallback(() => setKeyDialogOpen(false), []);

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
            setNewKey(body.key);
            setCreateOpen(false);
            setKeyDialogOpen(true);
            setName("");
            setCap("");
            load();
        } catch {
            setCreateError(t("externalApi.errorGeneric"));
        } finally {
            setCreating(false);
        }
    };

    const card = "mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";
    const primary = "rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900";
    const secondary = "rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-200";
    const input = "rounded-lg border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";

    return (
        <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-10" data-testid="external-api-settings">
            <SettingsDetailNav section="api-keys" currentLabel={t("externalApi.pageTitle")} backTestId="external-api-back" />
            <h1 className="mt-6 flex items-center gap-2 text-2xl font-black">
                <KeyRound className="h-6 w-6" aria-hidden="true" />
                {t("externalApi.pageTitle")}
            </h1>
            <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{t("externalApi.introShort")}</p>

            {signedOut ? (
                <section className={card} data-testid="external-api-signin">
                    <p className="text-sm text-zinc-600 dark:text-zinc-300">{t("externalApi.signInRequired")}</p>
                    <Link href={`/auth/signin?callbackUrl=${encodeURIComponent("/settings/api")}`} className={`mt-3 inline-flex ${primary}`}>
                        {t("auth.login")}
                    </Link>
                </section>
            ) : null}
            {failed && !overview && !signedOut ? <p className="mt-8 text-sm text-zinc-600 dark:text-zinc-300">{t("externalApi.loadFailed")}</p> : null}
            {!failed && !overview ? <p className="mt-8 text-sm text-zinc-500">{t("externalApi.loading")}</p> : null}
            {overview && !overview.enabled ? (
                <>
                    {overview.reason === "plan_not_eligible" ? (
                        <section className={card} data-testid="external-api-paid-plan">
                            <p className="text-sm text-zinc-600 dark:text-zinc-300">{t("externalApi.paidPlanRequired")}</p>
                            <Link href={settingsHrefForProduct(`${SETTINGS_HOME_PATH}?${SETTINGS_TAB_QUERY_PARAM}=plan`, product)} data-testid="external-api-upgrade" className={`mt-3 inline-flex ${primary}`}>
                                {t("externalApi.paidPlanUpgrade")}
                            </Link>
                        </section>
                    ) : (
                        <p className={`${card} text-sm`} data-testid="external-api-unavailable">
                            {t("externalApi.unavailable")}
                        </p>
                    )}
                    {overview.keys?.length ? (
                        // Still listed so a key issued earlier can be revoked.
                        <section className={card}>
                            <h2 className="text-base font-bold">{t("externalApi.keysTitle")}</h2>
                            <KeyList keys={overview.keys} onChanged={load} revokeOnly />
                        </section>
                    ) : null}
                </>
            ) : null}

            {overview && overview.enabled ? (
                <>
                    <section className={card}>
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-base font-bold">{t("externalApi.keysTitle")}</h2>
                            <button type="button" data-testid="external-api-new" onClick={() => setCreateOpen(true)} className={primary}>
                                + {t("externalApi.newKey")}
                            </button>
                        </div>
                        {overview.keys.length === 0 ? (
                            <p className="mt-3 text-sm text-zinc-500">{t("externalApi.noKeys")}</p>
                        ) : (
                            <KeyList keys={overview.keys} onChanged={load} maxCreditCap={overview.limits.maxCreditCap} />
                        )}
                        <Link href={settingsHrefForProduct(`${SETTINGS_HOME_PATH}?${SETTINGS_TAB_QUERY_PARAM}=plan`, product)} className="mt-3 inline-block text-sm font-semibold text-blue-600 hover:underline dark:text-blue-400">
                            {t("externalApi.accountUsageLink")}
                        </Link>
                    </section>

                    <ConnectSection
                        baseUrl={overview.baseUrl}
                        models={overview.models}
                        codingBaseUrl={overview.codingBaseUrl ?? overview.baseUrl}
                        codingModels={overview.codingModels ?? overview.models}
                        apiKey={newKey}
                        tomverseCli={overview.tomverseCli}
                    />

                    <section className={card} data-testid="external-api-allowed-models">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-base font-bold">{t("externalApi.modelsTitle")}</h2>
                            <span className="text-xs text-zinc-500">{fill(t("externalApi.modelsCount"), { count: listedModels(overview).length })}</span>
                        </div>
                        <p className="mt-1 text-sm text-zinc-500">{t("externalApi.modelsIntro")}</p>
                        {listedModels(overview).length === 0 ? (
                            <p className="mt-2 text-sm text-zinc-500">{t("externalApi.noModels")}</p>
                        ) : (
                            <ModelSearchList
                                models={listedModels(overview)}
                                toolsFor={(model) =>
                                    toolsForModel(model, t("externalApi.platformOther"), {
                                        general: overview.models.some((entry) => entry.id === model.id),
                                        coding: (overview.codingModels ?? overview.models).some((entry) => entry.id === model.id),
                                    })
                                }
                                testId="external-api-models"
                            />
                        )}
                    </section>

                    <details className="mt-6 rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800">
                        <summary className="cursor-pointer font-semibold">{t("externalApi.toolErrorsTitle")}</summary>
                        <p className="mt-2 text-xs leading-5">{t("externalApi.toolErrors")}</p>
                    </details>

                    {createOpen ? (
                        <Modal title={t("externalApi.createTitle")} onClose={closeCreate} testId="external-api-create-dialog">
                            <p className="mt-1 text-sm text-zinc-500">{t("externalApi.createIntro")}</p>
                            <form
                                className="mt-4 grid gap-3"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void create();
                                }}
                            >
                                <label className="grid gap-1 text-sm">
                                    <span className="font-semibold">{t("externalApi.nameLabel")}</span>
                                    <input autoFocus data-testid="external-api-name" required maxLength={80} value={name} placeholder={t("externalApi.namePlaceholder")} onChange={(event) => setName(event.target.value)} className={input} />
                                </label>
                                <label className="grid gap-1 text-sm">
                                    <span className="font-semibold">{t("externalApi.capLabel")}</span>
                                    <input data-testid="external-api-cap" inputMode="numeric" value={cap} onChange={(event) => setCap(event.target.value)} className={input} />
                                    <span className="text-xs text-zinc-500">{t("externalApi.capHint")}</span>
                                </label>
                                <label className="grid gap-1 text-sm">
                                    <span className="font-semibold">{t("externalApi.expiryLabel")}</span>
                                    <select data-testid="external-api-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value)} className={input}>
                                        {overview.limits.expiryDays.map((days) => (
                                            <option key={days} value={String(days)}>
                                                {fill(t("externalApi.expiryDays"), { days })}
                                            </option>
                                        ))}
                                        <option value="never">{t("externalApi.expiryNever")}</option>
                                    </select>
                                </label>
                                {createError ? <p className="text-sm text-red-600">{createError}</p> : null}
                                <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                    <button type="button" onClick={closeCreate} className={secondary}>
                                        {t("externalApi.cancel")}
                                    </button>
                                    <button type="submit" data-testid="external-api-create" disabled={creating || !name.trim()} className={primary}>
                                        {creating ? t("externalApi.creating") : t("externalApi.createButton")}
                                    </button>
                                </div>
                            </form>
                        </Modal>
                    ) : null}

                    {keyDialogOpen && newKey ? (
                        <Modal title={t("externalApi.createdTitle")} onClose={closeKeyDialog} testId="external-api-created">
                            <p className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                                {t("externalApi.createdBody")}
                            </p>
                            <CopyBlock label="API key" value={newKey} testId="external-api-created-key" />
                            <p className="mt-3 text-xs text-zinc-500">{t("externalApi.keyFilledIn")}</p>
                            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                <button type="button" onClick={closeKeyDialog} className={secondary}>
                                    {t("externalApi.close")}
                                </button>
                                <button
                                    type="button"
                                    data-testid="external-api-created-done"
                                    onClick={() => {
                                        closeKeyDialog();
                                        document.getElementById("connect")?.scrollIntoView({ behavior: "smooth", block: "start" });
                                    }}
                                    className={primary}
                                >
                                    {t("externalApi.savedGoConnect")}
                                </button>
                            </div>
                        </Modal>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
