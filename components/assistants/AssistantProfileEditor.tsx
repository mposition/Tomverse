"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Save, Trash2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * Creating and editing one profile (Release C, slice C3b).
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §21.
 *
 * ## Why identity and behaviour save separately
 *
 * §14 pins a conversation to the version it started on. Renaming a profile is
 * not a behaviour change and must not spend a revision; editing instructions
 * is and must. So this screen has two saves, and says so — one PATCH for the
 * name and one publish for everything else. Collapsing them into a single
 * "Save" would either publish a revision for a typo in the description, or
 * silently change what a running conversation is recorded as using.
 *
 * ## The stale conflict is shown, never resolved
 *
 * The editor carries the revision it loaded. A 409 comes back as an explicit
 * "this changed underneath you, reload" rather than as a retry: the other tab's
 * edit is somebody's work, and picking a winner here would discard it without
 * anyone seeing what was lost.
 */

const interpolate = (
    template: string,
    values: Record<string, string | number>
) =>
    Object.entries(values).reduce(
        (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
        template
    );

const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";
const primaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const fieldClass =
    "mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-base text-zinc-900 focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100";
const labelClass = "block text-sm font-semibold";

type KnowledgeFile = {
    id: string;
    name: string;
    processingStatus: string;
    chunkCount: number;
};

type VersionSummary = { id: string; revision: number; createdAt: string };

type LoadedProfile = {
    id: string;
    name: string;
    icon: string | null;
    description: string | null;
    currentVersionId: string | null;
    currentVersion: {
        revision: number;
        instructions: string;
        models: string[];
        toolPolicy: { webSearch: boolean; deepResearch: boolean };
        memoryPolicy: { useAccountMemory: boolean };
        starters: string[];
        knowledgeManifest: { fileId: string; name: string; digest: string }[];
    } | null;
    versions: VersionSummary[];
    knowledgeFiles: KnowledgeFile[];
};

type Notice =
    | { kind: "saved" }
    | { kind: "published"; revision: number }
    | { kind: "unchanged" }
    | { kind: "stale" }
    | { kind: "failed"; detail?: string };

export function AssistantProfileEditor({ profileId }: { profileId?: string }) {
    const { t } = useLanguage();
    const router = useRouter();
    const isNew = !profileId;

    const [loading, setLoading] = useState(!isNew);
    const [disabled, setDisabled] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [busy, setBusy] = useState(false);

    const [name, setName] = useState("");
    const [icon, setIcon] = useState("");
    const [description, setDescription] = useState("");

    const [instructions, setInstructions] = useState("");
    const [modelIds, setModelIds] = useState("");
    const [webSearch, setWebSearch] = useState(false);
    const [deepResearch, setDeepResearch] = useState(false);
    const [useAccountMemory, setUseAccountMemory] = useState(true);
    const [starters, setStarters] = useState("");
    const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

    const [profile, setProfile] = useState<LoadedProfile | null>(null);
    /** The revision this editor loaded, sent back so a stale save is caught. */
    const [loadedRevision, setLoadedRevision] = useState<number | null>(null);

    const load = useCallback(async () => {
        if (!profileId) return;
        setLoading(true);
        try {
            const response = await fetch(`/api/assistant-profiles/${profileId}`, {
                cache: "no-store",
            });
            if (response.status === 403) {
                await discardResponseBody(response);
                setDisabled(true);
                return;
            }
            if (!response.ok) {
                await discardResponseBody(response);
                setNotice({ kind: "failed" });
                return;
            }
            const data = (await response.json()) as { profile: LoadedProfile };
            const loaded = data.profile;
            setProfile(loaded);
            setName(loaded.name);
            setIcon(loaded.icon ?? "");
            setDescription(loaded.description ?? "");
            const version = loaded.currentVersion;
            setLoadedRevision(version?.revision ?? null);
            setInstructions(version?.instructions ?? "");
            setModelIds((version?.models ?? []).join(", "));
            setWebSearch(version?.toolPolicy.webSearch ?? false);
            setDeepResearch(version?.toolPolicy.deepResearch ?? false);
            setUseAccountMemory(version?.memoryPolicy.useAccountMemory ?? true);
            setStarters((version?.starters ?? []).join("\n"));
            setSelectedFileIds(
                (version?.knowledgeManifest ?? []).map((entry) => entry.fileId)
            );
        } catch {
            setNotice({ kind: "failed" });
        } finally {
            setLoading(false);
        }
    }, [profileId]);

    useEffect(() => {
        // Deferred, as the other settings screens defer their loads: a state
        // update reachable synchronously from an effect is what
        // `react-hooks/set-state-in-effect` refuses, and the fetch has nothing
        // to gain from starting one tick earlier.
        queueMicrotask(() => {
            void load();
        });
    }, [load]);

    const saveIdentity = async () => {
        setBusy(true);
        setNotice(null);
        try {
            const body = JSON.stringify({
                name,
                icon: icon.trim() === "" ? null : icon,
                description: description.trim() === "" ? null : description,
            });
            const response = await fetch(
                isNew ? "/api/assistant-profiles" : `/api/assistant-profiles/${profileId}`,
                {
                    method: isNew ? "POST" : "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body,
                }
            );
            if (!response.ok) {
                const data = (await response.json().catch(() => null)) as
                    | { error?: string }
                    | null;
                setNotice({ kind: "failed", detail: data?.error });
                return;
            }
            const data = (await response.json()) as { profile: { id: string } };
            if (isNew) {
                // Straight to the editor for the profile that now exists, so
                // the next thing the user does is publish its first version --
                // an unpublished profile cannot start a conversation, and
                // leaving them on a "created" screen hides that.
                router.replace(`/settings/assistants/${data.profile.id}`);
                return;
            }
            setNotice({ kind: "saved" });
            await load();
        } catch {
            setNotice({ kind: "failed" });
        } finally {
            setBusy(false);
        }
    };

    const publish = async () => {
        if (!profileId) return;
        setBusy(true);
        setNotice(null);
        try {
            // Ids only. The server reads the name and the digest off the
            // rows, because a client-supplied digest would be a client
            // deciding what a past version is recorded as having contained.
            const knowledgeFileIds = (profile?.knowledgeFiles ?? [])
                .filter((file) => selectedFileIds.includes(file.id))
                .map((file) => file.id);
            const response = await fetch(
                `/api/assistant-profiles/${profileId}/versions`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        expectedRevision: loadedRevision,
                        instructions,
                        modelIds: modelIds
                            .split(",")
                            .map((id) => id.trim())
                            .filter(Boolean),
                        toolPolicy: { webSearch, deepResearch },
                        memoryPolicy: { useAccountMemory },
                        starters: starters
                            .split("\n")
                            .map((line) => line.trim())
                            .filter(Boolean),
                        knowledgeFileIds,
                    }),
                }
            );
            if (response.status === 409) {
                await discardResponseBody(response);
                setNotice({ kind: "stale" });
                return;
            }
            if (!response.ok) {
                const data = (await response.json().catch(() => null)) as
                    | { error?: string }
                    | null;
                setNotice({ kind: "failed", detail: data?.error });
                return;
            }
            const data = (await response.json()) as
                | { outcome: "published"; version: { revision: number } }
                | { outcome: "unchanged"; revision: number };
            setNotice(
                data.outcome === "published"
                    ? { kind: "published", revision: data.version.revision }
                    : { kind: "unchanged" }
            );
            await load();
        } catch {
            setNotice({ kind: "failed" });
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!profileId) return;
        setBusy(true);
        try {
            const response = await fetch(`/api/assistant-profiles/${profileId}`, {
                method: "DELETE",
            });
            await discardResponseBody(response);
            if (response.ok) router.replace("/settings/assistants");
            else setNotice({ kind: "failed" });
        } catch {
            setNotice({ kind: "failed" });
        } finally {
            setBusy(false);
        }
    };

    if (disabled) {
        return (
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
                <SettingsDetailNav
                    section="assistants"
                    currentLabel={t("assistantProfiles.pageTitle")}
                    backTestId="assistants-back-to-settings"
                />
                <p
                    className={`mt-6 ${sectionClass} text-sm`}
                    data-testid="assistants-disabled"
                >
                    {t("assistantProfiles.disabled")}
                </p>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <SettingsDetailNav
                section="assistants"
                currentLabel={t("assistantProfiles.pageTitle")}
                backTestId="assistants-back-to-settings"
            />

            <h1 className="mt-4 text-2xl font-black">
                {isNew
                    ? t("assistantProfiles.newTitle")
                    : t("assistantProfiles.editTitle")}
            </h1>

            {loading ? (
                <p className="mt-6 flex items-center gap-2 text-sm text-zinc-500">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t("assistantProfiles.loading")}
                </p>
            ) : (
                <>
                    {notice && (
                        <p
                            className={`mt-4 ${sectionClass} flex items-start gap-2 text-sm ${
                                notice.kind === "failed" || notice.kind === "stale"
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-zinc-700 dark:text-zinc-300"
                            }`}
                            data-testid={`assistants-notice-${notice.kind}`}
                            role="status"
                        >
                            {(notice.kind === "failed" || notice.kind === "stale") && (
                                <AlertTriangle
                                    className="mt-0.5 h-4 w-4 shrink-0"
                                    aria-hidden="true"
                                />
                            )}
                            {notice.kind === "saved" && t("assistantProfiles.noticeSaved")}
                            {notice.kind === "published" &&
                                interpolate(t("assistantProfiles.noticePublished"), {
                                    revision: notice.revision,
                                })}
                            {notice.kind === "unchanged" &&
                                t("assistantProfiles.noticeUnchanged")}
                            {notice.kind === "stale" && t("assistantProfiles.noticeStale")}
                            {notice.kind === "failed" &&
                                (notice.detail || t("assistantProfiles.noticeFailed"))}
                        </p>
                    )}

                    {/* Identity: saved on its own, because a rename is not a
                        behaviour change and must not spend a revision. */}
                    <section className={`mt-6 ${sectionClass}`}>
                        <h2 className="text-lg font-bold">
                            {t("assistantProfiles.identityHeading")}
                        </h2>
                        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                            {t("assistantProfiles.identityHint")}
                        </p>
                        <div className="mt-4 flex flex-col gap-4">
                            <label className={labelClass}>
                                {t("assistantProfiles.nameLabel")}
                                <input
                                    className={fieldClass}
                                    value={name}
                                    maxLength={ASSISTANT_PROFILE_LIMITS.maxNameCharacters}
                                    onChange={(event) => setName(event.target.value)}
                                    data-testid="assistant-name"
                                />
                            </label>
                            <label className={labelClass}>
                                {t("assistantProfiles.iconLabel")}
                                <input
                                    className={fieldClass}
                                    value={icon}
                                    maxLength={ASSISTANT_PROFILE_LIMITS.maxIconCharacters}
                                    onChange={(event) => setIcon(event.target.value)}
                                    data-testid="assistant-icon"
                                />
                            </label>
                            <label className={labelClass}>
                                {t("assistantProfiles.descriptionLabel")}
                                <input
                                    className={fieldClass}
                                    value={description}
                                    maxLength={
                                        ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters
                                    }
                                    onChange={(event) => setDescription(event.target.value)}
                                    data-testid="assistant-description"
                                />
                            </label>
                        </div>
                        <button
                            type="button"
                            className={`mt-4 ${primaryButtonClass}`}
                            onClick={() => void saveIdentity()}
                            disabled={busy || name.trim() === ""}
                            data-testid="assistant-save-identity"
                        >
                            <Save className="h-4 w-4" aria-hidden="true" />
                            {isNew
                                ? t("assistantProfiles.createAction")
                                : t("assistantProfiles.saveIdentity")}
                        </button>
                    </section>

                    {!isNew && (
                        <>
                            {/* Behaviour: published as a revision, so the
                                conversations already running keep theirs. */}
                            <section className={`mt-4 ${sectionClass}`}>
                                <h2 className="text-lg font-bold">
                                    {t("assistantProfiles.behaviourHeading")}
                                </h2>
                                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                                    {t("assistantProfiles.behaviourHint")}
                                </p>
                                <div className="mt-4 flex flex-col gap-4">
                                    <label className={labelClass}>
                                        {t("assistantProfiles.instructionsLabel")}
                                        <textarea
                                            className={`${fieldClass} min-h-40`}
                                            value={instructions}
                                            maxLength={
                                                ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters
                                            }
                                            onChange={(event) =>
                                                setInstructions(event.target.value)
                                            }
                                            data-testid="assistant-instructions"
                                        />
                                    </label>
                                    <label className={labelClass}>
                                        {t("assistantProfiles.modelsLabel")}
                                        <input
                                            className={fieldClass}
                                            value={modelIds}
                                            onChange={(event) =>
                                                setModelIds(event.target.value)
                                            }
                                            data-testid="assistant-models"
                                        />
                                    </label>
                                    <label className={labelClass}>
                                        {t("assistantProfiles.startersLabel")}
                                        <textarea
                                            className={`${fieldClass} min-h-24`}
                                            value={starters}
                                            onChange={(event) =>
                                                setStarters(event.target.value)
                                            }
                                            data-testid="assistant-starters"
                                        />
                                    </label>

                                    <fieldset className="flex flex-col gap-2">
                                        <legend className="text-sm font-semibold">
                                            {t("assistantProfiles.toolsLabel")}
                                        </legend>
                                        <label className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={webSearch}
                                                onChange={(event) =>
                                                    setWebSearch(event.target.checked)
                                                }
                                                data-testid="assistant-web-search"
                                            />
                                            {t("assistantProfiles.toolWebSearch")}
                                        </label>
                                        <label className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={deepResearch}
                                                onChange={(event) =>
                                                    setDeepResearch(event.target.checked)
                                                }
                                                data-testid="assistant-deep-research"
                                            />
                                            {t("assistantProfiles.toolDeepResearch")}
                                        </label>
                                        <p className="text-xs text-zinc-500">
                                            {t("assistantProfiles.toolsNarrowOnly")}
                                        </p>
                                    </fieldset>

                                    <label className="flex items-center gap-2 text-sm font-semibold">
                                        <input
                                            type="checkbox"
                                            checked={useAccountMemory}
                                            onChange={(event) =>
                                                setUseAccountMemory(event.target.checked)
                                            }
                                            data-testid="assistant-use-memory"
                                        />
                                        {t("assistantProfiles.memoryLabel")}
                                    </label>
                                    <p className="-mt-2 text-xs text-zinc-500">
                                        {t("assistantProfiles.memoryNarrowOnly")}
                                    </p>

                                    {(profile?.knowledgeFiles.length ?? 0) > 0 && (
                                        <fieldset className="flex flex-col gap-2">
                                            <legend className="text-sm font-semibold">
                                                {t("assistantProfiles.knowledgeLabel")}
                                            </legend>
                                            {profile?.knowledgeFiles.map((file) => (
                                                <label
                                                    key={file.id}
                                                    className="flex items-center gap-2 text-sm"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedFileIds.includes(
                                                            file.id
                                                        )}
                                                        disabled={
                                                            file.processingStatus !== "ready"
                                                        }
                                                        onChange={(event) =>
                                                            setSelectedFileIds((current) =>
                                                                event.target.checked
                                                                    ? [...current, file.id]
                                                                    : current.filter(
                                                                          (id) => id !== file.id
                                                                      )
                                                            )
                                                        }
                                                        data-testid={`assistant-knowledge-${file.id}`}
                                                    />
                                                    <span>{file.name}</span>
                                                    {file.processingStatus !== "ready" && (
                                                        <span className="text-xs text-zinc-500">
                                                            {t(
                                                                `assistantProfiles.fileStatus.${file.processingStatus}`
                                                            )}
                                                        </span>
                                                    )}
                                                </label>
                                            ))}
                                        </fieldset>
                                    )}
                                </div>

                                <button
                                    type="button"
                                    className={`mt-4 ${primaryButtonClass}`}
                                    onClick={() => void publish()}
                                    disabled={busy}
                                    data-testid="assistant-publish"
                                >
                                    <Save className="h-4 w-4" aria-hidden="true" />
                                    {t("assistantProfiles.publish")}
                                </button>
                            </section>

                            <section className={`mt-4 ${sectionClass}`}>
                                <h2 className="text-lg font-bold">
                                    {t("assistantProfiles.historyHeading")}
                                </h2>
                                {profile && profile.versions.length > 0 ? (
                                    <ul
                                        className="mt-3 flex flex-col gap-1 text-sm"
                                        data-testid="assistant-version-history"
                                    >
                                        {profile.versions.map((version) => (
                                            <li key={version.id}>
                                                {interpolate(
                                                    t("assistantProfiles.historyEntry"),
                                                    { revision: version.revision }
                                                )}
                                                {version.id === profile.currentVersionId && (
                                                    <span className="ml-2 text-xs font-bold text-blue-600 dark:text-blue-400">
                                                        {t("assistantProfiles.historyCurrent")}
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
                                        {t("assistantProfiles.historyEmpty")}
                                    </p>
                                )}
                            </section>

                            <section className={`mt-4 ${sectionClass}`}>
                                <h2 className="text-lg font-bold">
                                    {t("assistantProfiles.deleteHeading")}
                                </h2>
                                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                                    {t("assistantProfiles.deleteHint")}
                                </p>
                                <button
                                    type="button"
                                    className={`mt-3 ${secondaryButtonClass}`}
                                    onClick={() => void remove()}
                                    disabled={busy}
                                    data-testid="assistant-delete"
                                >
                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                    {t("assistantProfiles.deleteAction")}
                                </button>
                            </section>
                        </>
                    )}
                </>
            )}
        </div>
    );
}
