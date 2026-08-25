"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
    AlertTriangle,
    ArrowLeft,
    ChevronDown,
    Loader2,
    Save,
    Trash2,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { KnowledgeFilesPanel } from "@/components/assistants/KnowledgeFilesPanel";
import {
    ModelSelector,
    type ModelMode,
} from "@/components/assistants/ModelSelector";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import {
    ASSISTANT_PROFILE_LIST_PATH,
    assistantProfileHierarchy,
} from "@/lib/settingsNavigation";
import { ASSISTANT_PROFILE_CHAT_PATH } from "@/lib/assistantProfileReturn";
import { assistantProfileErrorCopyKey } from "@/lib/assistantProfileErrorCopy";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { APP_DEFAULTS } from "@/lib/appDefaults";
// Still needed after the control moved out: the editor seeds the explicit mode
// with the account default, which is a question about this screen's state
// rather than about how the list renders.
import { ENABLED_MODELS } from "@/lib/models";

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
 *
 * ## Creating asks for two things, editing offers all of them
 *
 * The create screen used to ask for identity, save it, land the user in the
 * editor, and require a second save before the profile could be used at all.
 * Both halves are gone: the first save now carries instructions and publishes
 * revision 1 with them (one request, one transaction), and everything that is
 * not a name or an instruction moved behind a closed `<details>`.
 *
 * That is disclosure, not removal. Icons, models, starters, tools, memory and
 * knowledge are all still here and still write the same fields — they are just
 * not decisions anybody has to make before their first profile works. The
 * defaults they take are the narrow ones (§14): no tools, no account memory,
 * no starters, and the model the account already starts new conversations
 * with.
 *
 * Revisions are still revisions. What changed is the word on the button: a
 * user saving an edit is told their profile was updated, and the revision
 * numbers stay in the history section for whoever wants them.
 */

const interpolate = (
    template: string,
    values: Record<string, string | number>
) =>
    Object.entries(values).reduce(
        (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
        template
    );

/**
 * What a failed response says, as a code this screen can translate.
 *
 * A 401 is the one case with no code to read: the route answers
 * `{ error: "Unauthorized" }` before any handler runs, so the client names
 * the case itself rather than falling back to "try again", which is the
 * wrong advice for a session that expired mid-edit.
 */
const failureNotice = async (
    response: Response
): Promise<Extract<Notice, { kind: "failed" }>> => {
    if (response.status === 401) {
        await discardResponseBody(response);
        return { kind: "failed", code: "UNAUTHENTICATED" };
    }
    const body = (await response.json().catch(() => null)) as {
        code?: string;
    } | null;
    return { kind: "failed", code: body?.code };
};

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
    /** Published package imports, newest first. Absent on older payloads. */
    imports?: ImportProvenance[];
};

/**
 * What a package said about itself, and what the server observed.
 *
 * The `declared*` half is the package's claim -- the server never saw the
 * container -- so it is display-only and the copy says so
 * (`docs/policy/assistant-package-import.md` §6.5). The timestamp is the
 * server's own, and the host is all that survives of a URL nothing ever
 * fetches (same document, §7).
 */
type ImportProvenance = {
    id: string;
    declaredSourceKind: string | null;
    declaredSourceName: string | null;
    declaredSourceHost: string | null;
    serverReceivedAt: string;
    versionId: string | null;
};

type Notice =
    | { kind: "saved" }
    | { kind: "published"; revision: number }
    | { kind: "unchanged" }
    | { kind: "stale" }
    /**
     * The server's refusal *code*, never its message.
     *
     * This field held `detail` -- the `error` string the API returns -- and
     * the screen printed it. Those strings are written for operators and
     * exist only in English, so a Korean user saw `Invalid request payload.`
     * with no field named and no next step. The code resolves to a sentence
     * this product owns, in the reader's language
     * (`lib/assistantProfileErrorCopy.ts`); an unmapped one falls back to the
     * generic message rather than showing the code.
     */
    | { kind: "failed"; code?: string };

export function AssistantProfileEditor({
    profileId,
    onCreated,
    knowledgeEnabled = false,
}: {
    profileId?: string;
    /**
     * Whether assistant knowledge files are enabled, resolved on the server.
     *
     * Defaults to `false` because the one caller that omits it is the create
     * screen, which has no `profileId` and so never renders the knowledge
     * panel at all. Defaulting the other way would make a screen that cannot
     * show the panel claim the feature is on.
     */
    knowledgeEnabled?: boolean;
    /**
     * Where a create should go instead of the profile's own edit page.
     *
     * Supplied by the chat entry point, which wants the user back in the
     * conversation they left. Absent everywhere else, and the fallback is the
     * edit page — the same destination as before.
     */
    onCreated?: (profileId: string) => void;
}) {
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
    /**
     * Real ids, chosen from the catalogue rather than typed.
     *
     * This was a comma-separated text field holding internal model ids, which
     * asked the user to know strings like `gpt-5-6-luna` and spell them
     * correctly — and silently produced a profile naming a model that does not
     * exist when they did not.
     */
    const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
    /**
     * Naming no model is the default, and it is what a created profile now
     * stores. The old create screen resolved the account's default and wrote
     * it into revision 1, which pinned it: changing the account default later
     * left every existing assistant starting conversations on the old one.
     */
    const [modelMode, setModelMode] = useState<ModelMode>("account-default");
    const [webSearch, setWebSearch] = useState(false);
    const [deepResearch, setDeepResearch] = useState(false);
    // §14's narrow-only default. A new profile asks for nothing it was not
    // told to ask for; the editor's checkbox is how it gets widened.
    const [useAccountMemory, setUseAccountMemory] = useState(false);
    const [starters, setStarters] = useState("");
    const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    /** Which field a refused save belongs to, so focus can go there. */
    const [invalidField, setInvalidField] = useState<
        "name" | "instructions" | null
    >(null);

    /**
     * Switching modes, with the selection kept coherent with the mode.
     *
     * Entering `explicit` seeds the account's default so the mode always has
     * at least one model in it, and leaving it keeps the ticks so a user who
     * flips back and forth does not lose what they chose — the stored value is
     * decided by the mode at save time, not by what is still ticked.
     */
    const changeModelMode = (next: ModelMode) => {
        setModelMode(next);
        if (next === "explicit" && selectedModelIds.length === 0) {
            const seed =
                ENABLED_MODELS.find(
                    (model) => model.id === APP_DEFAULTS.defaultModelId
                ) ?? ENABLED_MODELS[0];
            if (seed) setSelectedModelIds([seed.id]);
        }
    };

    /** What the mode says to store, rather than what is still ticked. */
    const modelIdsForSave = () =>
        modelMode === "explicit" ? selectedModelIds : [];

    // "Create and use in this chat" only when there is a chat to go back to.
    // Promising it from the settings page would name a destination the button
    // does not have.
    // The same signal the label reads, so the funnel and the button can never
    // disagree about which entry point this is.
    const analyticsEntry = onCreated ? "chat" : "settings";

    const createActionLabel = onCreated
        ? t("assistantProfiles.createAndUseAction")
        : t("assistantProfiles.createAction");

    const advancedPanelId = useId();
    const nameRef = useRef<HTMLInputElement | null>(null);
    const instructionsRef = useRef<HTMLTextAreaElement | null>(null);

    const [profile, setProfile] = useState<LoadedProfile | null>(null);
    /**
     * What the breadcrumb calls this page.
     *
     * The profile's own name once it is loaded, because that is what the page
     * is; a generic fallback while it is not, because a crumb reading the name
     * of a profile that has not arrived would be a claim rather than a label.
     */
    const detailLabel = isNew
        ? t("assistantProfiles.newTitle")
        : profile?.name || t("assistantProfiles.editTitle");

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
                setNotice(await failureNotice(response));
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
            const storedModels = version?.models ?? [];
            setSelectedModelIds(storedModels);
            setModelMode(
                storedModels.length > 0 ? "explicit" : "account-default"
            );
            setWebSearch(version?.toolPolicy.webSearch ?? false);
            setDeepResearch(version?.toolPolicy.deepResearch ?? false);
            setUseAccountMemory(version?.memoryPolicy.useAccountMemory ?? false);
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

    /**
     * Sends the whole profile in one request when creating, and only the
     * identity when editing.
     *
     * The split is §14's, not an artefact: a rename must not spend a revision,
     * so editing keeps its own PATCH and leaves behaviour to `publish()`.
     * Creating has no revision to protect, so it carries the instructions with
     * it and the server writes both rows in one transaction. That is what
     * removes the unusable in-between profile the old two-step flow produced.
     */
    const create = async () => {
        if (name.trim() === "") {
            setInvalidField("name");
            nameRef.current?.focus();
            return;
        }
        if (instructions.trim() === "") {
            setInvalidField("instructions");
            // The field lives inside the minimal form, so it is always
            // visible; opening advanced would be wrong here and is not done.
            instructionsRef.current?.focus();
            return;
        }
        setInvalidField(null);
        setBusy(true);
        setNotice(null);
        // After validation, so an empty form submitted twice does not read as
        // two attempts at making something.
        trackProductEvent("assistant_profile_create_started", 0, {
            assistant_profile_entry: analyticsEntry,
        });
        try {
            const response = await fetch("/api/assistant-profiles", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name,
                    icon: icon.trim() === "" ? null : icon,
                    description: description.trim() === "" ? null : description,
                    instructions,
                    // Omitted, not guessed, when the profile names no model:
                    // the account's own new-conversation selection is
                    // resolved when a conversation is actually created, and a
                    // client-supplied default would pin today's answer to a
                    // question asked later.
                    ...(modelIdsForSave().length > 0
                        ? { modelIds: modelIdsForSave() }
                        : {}),
                }),
            });
            if (!response.ok) {
                setNotice(await failureNotice(response));
                return;
            }
            const data = (await response.json()) as { profile: { id: string } };
            trackProductEvent("assistant_profile_create_completed", 0, {
                assistant_profile_entry: analyticsEntry,
            });
            onCreated?.(data.profile.id);
            if (!onCreated) router.replace(`/settings/assistants/${data.profile.id}`);
        } catch {
            setNotice({ kind: "failed" });
        } finally {
            setBusy(false);
        }
    };

    const saveIdentity = async () => {
        if (name.trim() === "") {
            setInvalidField("name");
            nameRef.current?.focus();
            return;
        }
        setInvalidField(null);
        setBusy(true);
        setNotice(null);
        try {
            const response = await fetch(
                `/api/assistant-profiles/${profileId}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name,
                        icon: icon.trim() === "" ? null : icon,
                        description:
                            description.trim() === "" ? null : description,
                    }),
                }
            );
            if (!response.ok) {
                setNotice(await failureNotice(response));
                return;
            }
            await discardResponseBody(response);
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
                        modelIds: modelIdsForSave(),
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
            if (!response.ok) {
                const failure = await failureNotice(response);
                // The stale conflict has its own notice, because its next
                // step is a reload rather than a retry. Decided by the code
                // and not by the 409 alone: the account ceiling answers 409
                // too, and telling somebody at their profile limit that
                // another tab edited this one would send them to reload a
                // screen that is already current.
                setNotice(
                    failure.code === "ASSISTANT_PROFILE_VERSION_STALE"
                        ? { kind: "stale" }
                        : failure
                );
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
            if (!response.ok) {
                setNotice(await failureNotice(response));
                return;
            }
            await discardResponseBody(response);
            router.replace(ASSISTANT_PROFILE_LIST_PATH);
        } catch {
            setNotice({ kind: "failed" });
        } finally {
            setBusy(false);
        }
    };

    /**
     * The one way up, decided once.
     *
     * Loading, error, disabled and the loaded page all render this, because a
     * page that offers a different parent depending on what it managed to
     * fetch is a page whose hierarchy depends on the network.
     *
     * Opened from a conversation, the way out is the conversation rather than
     * a list the visitor never saw -- and it is a plain link rather than a
     * trail, because the chat is not a settings ancestor and putting it in the
     * breadcrumb would claim settings sits underneath it. The destination is a
     * constant either way; the query parameter that got the visitor here is
     * compared to a literal and never read as a place to go
     * (lib/assistantProfileReturn.ts).
     */
    const upwardNav = onCreated ? (
                <nav
                    aria-label={t("settingsNav.navLabel")}
                    data-testid="settings-detail-nav"
                >
                    <Link
                        href={ASSISTANT_PROFILE_CHAT_PATH}
                        data-testid="assistant-create-back"
                        className="inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold text-zinc-500 transition-colors hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-50 dark:hover:text-zinc-100 dark:focus-visible:ring-offset-zinc-950"
                    >
                        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                        {t("assistantProfiles.backToChat")}
                    </Link>
                </nav>
    ) : (
        <SettingsDetailNav
            hierarchy={assistantProfileHierarchy({ focusProfileId: profileId })}
            currentLabel={detailLabel}
            backTestId={isNew ? "assistant-create-back" : "assistant-back-to-list"}
        />
    );

    if (disabled) {
        return (
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
                {upwardNav}
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
            {upwardNav}

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
                            {/* The revision is still recorded and still
                                shown in the history below; what changed is
                                that a user saving an edit is told their
                                profile was updated rather than that a
                                numbered snapshot was published. */}
                            {notice.kind === "published" &&
                                t("assistantProfiles.noticePublished")}
                            {notice.kind === "unchanged" &&
                                t("assistantProfiles.noticeUnchanged")}
                            {notice.kind === "stale" && t("assistantProfiles.noticeStale")}
                            {notice.kind === "failed" &&
                                t(
                                    assistantProfileErrorCopyKey(notice.code) ??
                                        "assistantProfiles.noticeFailed"
                                )}
                        </p>
                    )}

                    {/* Identity: saved on its own when editing, because a
                        rename is not a behaviour change and must not spend a
                        revision. When creating, this form is the whole thing
                        and its button publishes revision 1 with it. */}
                    <section className={`mt-6 ${sectionClass}`}>
                        <h2 className="text-lg font-bold">
                            {t("assistantProfiles.identityHeading")}
                        </h2>
                        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                            {isNew
                                ? t("assistantProfiles.createHint")
                                : t("assistantProfiles.identityHint")}
                        </p>
                        <div className="mt-4 flex flex-col gap-4">
                            <label className={labelClass}>
                                {t("assistantProfiles.nameLabel")}
                                <input
                                    ref={nameRef}
                                    className={fieldClass}
                                    value={name}
                                    maxLength={ASSISTANT_PROFILE_LIMITS.maxNameCharacters}
                                    onChange={(event) => {
                                        setName(event.target.value);
                                        if (invalidField === "name") setInvalidField(null);
                                    }}
                                    aria-invalid={invalidField === "name" || undefined}
                                    aria-describedby={
                                        invalidField === "name"
                                            ? "assistant-name-error"
                                            : undefined
                                    }
                                    data-testid="assistant-name"
                                />
                            </label>
                            {invalidField === "name" && (
                                <p
                                    id="assistant-name-error"
                                    className="-mt-2 text-sm text-red-600 dark:text-red-400"
                                    data-testid="assistant-name-error"
                                >
                                    {t("assistantProfiles.nameRequired")}
                                </p>
                            )}

                            {/* Instructions sit in the minimal form, not
                                behind advanced: they are the reason somebody
                                makes a profile, and a create that asked only
                                for a name produced an assistant that did
                                nothing. */}
                            {isNew && (
                                <>
                                    <label className={labelClass}>
                                        {t("assistantProfiles.instructionsLabel")}
                                        <textarea
                                            ref={instructionsRef}
                                            className={`${fieldClass} min-h-40`}
                                            value={instructions}
                                            maxLength={
                                                ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters
                                            }
                                            placeholder={t(
                                                "assistantProfiles.instructionsPlaceholder"
                                            )}
                                            onChange={(event) => {
                                                setInstructions(event.target.value);
                                                if (invalidField === "instructions") {
                                                    setInvalidField(null);
                                                }
                                            }}
                                            aria-invalid={
                                                invalidField === "instructions" || undefined
                                            }
                                            aria-describedby={
                                                invalidField === "instructions"
                                                    ? "assistant-instructions-error"
                                                    : undefined
                                            }
                                            data-testid="assistant-instructions"
                                        />
                                    </label>
                                    {invalidField === "instructions" && (
                                        <p
                                            id="assistant-instructions-error"
                                            className="-mt-2 text-sm text-red-600 dark:text-red-400"
                                            data-testid="assistant-instructions-error"
                                        >
                                            {t("assistantProfiles.instructionsRequired")}
                                        </p>
                                    )}
                                </>
                            )}

                            <label className={labelClass}>
                                {t("assistantProfiles.descriptionLabel")}
                                <span className="ml-1 text-xs font-normal text-zinc-500">
                                    {t("assistantProfiles.optionalSuffix")}
                                </span>
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

                            {!isNew && (
                                <label className={labelClass}>
                                    {t("assistantProfiles.iconLabel")}
                                    <span className="ml-1 text-xs font-normal text-zinc-500">
                                        {t("assistantProfiles.optionalSuffix")}
                                    </span>
                                    <input
                                        className={fieldClass}
                                        value={icon}
                                        maxLength={ASSISTANT_PROFILE_LIMITS.maxIconCharacters}
                                        onChange={(event) => setIcon(event.target.value)}
                                        data-testid="assistant-icon"
                                    />
                                </label>
                            )}
                        </div>

                        {isNew && (
                            <details
                                className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800"
                                open={advancedOpen}
                                onToggle={(event) =>
                                    setAdvancedOpen(
                                        (event.currentTarget as HTMLDetailsElement).open
                                    )
                                }
                                data-testid="assistant-advanced"
                            >
                                <summary
                                    className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                    aria-expanded={advancedOpen}
                                    aria-controls={advancedPanelId}
                                    data-testid="assistant-advanced-toggle"
                                >
                                    <ChevronDown
                                        className={`h-4 w-4 transition-transform ${
                                            advancedOpen ? "rotate-180" : ""
                                        }`}
                                        aria-hidden="true"
                                    />
                                    {t("assistantProfiles.advancedHeading")}
                                </summary>
                                <div
                                    id={advancedPanelId}
                                    className="flex flex-col gap-4 border-t border-zinc-200 px-3 py-3 dark:border-zinc-800"
                                >
                                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                        {t("assistantProfiles.advancedHint")}
                                    </p>
                                    <label className={labelClass}>
                                        {t("assistantProfiles.iconLabel")}
                                        <span className="ml-1 text-xs font-normal text-zinc-500">
                                            {t("assistantProfiles.optionalSuffix")}
                                        </span>
                                        <input
                                            className={fieldClass}
                                            value={icon}
                                            maxLength={
                                                ASSISTANT_PROFILE_LIMITS.maxIconCharacters
                                            }
                                            onChange={(event) => setIcon(event.target.value)}
                                            data-testid="assistant-icon"
                                        />
                                    </label>
                                    <ModelSelector
                                        label={t("assistantProfiles.modelsLabel")}
                                        hint={t("assistantProfiles.modelsHint")}
                                        mode={modelMode}
                                        onModeChange={changeModelMode}
                                        selected={selectedModelIds}
                                        onChange={setSelectedModelIds}
                                        t={t}
                                    />
                                </div>
                            </details>
                        )}

                        <button
                            type="button"
                            className={`mt-4 ${primaryButtonClass}`}
                            onClick={() => void (isNew ? create() : saveIdentity())}
                            disabled={busy}
                            data-testid={
                                isNew ? "assistant-create" : "assistant-save-identity"
                            }
                        >
                            {busy ? (
                                <Loader2
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                />
                            ) : (
                                <Save className="h-4 w-4" aria-hidden="true" />
                            )}
                            {isNew
                                ? createActionLabel
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
                                    <ModelSelector
                                        label={t("assistantProfiles.modelsLabel")}
                                        hint={t("assistantProfiles.modelsHint")}
                                        mode={modelMode}
                                        onModeChange={changeModelMode}
                                        selected={selectedModelIds}
                                        onChange={setSelectedModelIds}
                                        t={t}
                                    />
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

                                    {profileId && profile && (
                                        <KnowledgeFilesPanel
                                            profileId={profileId}
                                            knowledgeEnabled={knowledgeEnabled}
                                            files={profile.knowledgeFiles}
                                            publishedManifest={
                                                profile.currentVersion
                                                    ?.knowledgeManifest ?? []
                                            }
                                            selectedFileIds={selectedFileIds}
                                            onToggleFile={(fileId, next) =>
                                                setSelectedFileIds((current) =>
                                                    next
                                                        ? [...current, fileId]
                                                        : current.filter(
                                                              (id) => id !== fileId
                                                          )
                                                )
                                            }
                                            onChanged={load}
                                        />
                                    )}
                                </div>

                                <button
                                    type="button"
                                    className={`mt-4 ${primaryButtonClass}`}
                                    onClick={() => void publish()}
                                    disabled={busy}
                                    data-testid="assistant-publish"
                                >
                                    {busy ? (
                                        <Loader2
                                            className="h-4 w-4 animate-spin"
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <Save className="h-4 w-4" aria-hidden="true" />
                                    )}
                                    {t("assistantProfiles.saveChanges")}
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

                            {profile && (profile.imports?.length ?? 0) > 0 && (
                                <section
                                    className={`mt-4 ${sectionClass}`}
                                    data-testid="assistant-provenance"
                                >
                                    <h2 className="text-lg font-bold">
                                        {t("assistantProfiles.provenanceHeading")}
                                    </h2>
                                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                                        {t("assistantProfiles.provenanceHint")}
                                    </p>
                                    <ul className="mt-3 flex flex-col gap-2 text-sm">
                                        {(profile.imports ?? []).map((entry) => (
                                            <li key={entry.id}>
                                                <p>
                                                    {interpolate(
                                                        t(
                                                            "assistantProfiles.provenanceEntry"
                                                        ),
                                                        {
                                                            // Both are the
                                                            // package's own
                                                            // words. The copy
                                                            // reads "states"
                                                            // for that reason.
                                                            kind:
                                                                entry.declaredSourceKind ??
                                                                t(
                                                                    "assistantProfiles.provenanceUnstated"
                                                                ),
                                                            name:
                                                                entry.declaredSourceName ??
                                                                t(
                                                                    "assistantProfiles.provenanceUnstated"
                                                                ),
                                                        }
                                                    )}
                                                </p>
                                                <p className="text-xs text-zinc-500">
                                                    {interpolate(
                                                        t(
                                                            "assistantProfiles.provenanceReceived"
                                                        ),
                                                        {
                                                            date: new Date(
                                                                entry.serverReceivedAt
                                                            ).toLocaleString(),
                                                        }
                                                    )}
                                                    {entry.declaredSourceHost && (
                                                        <>
                                                            {" · "}
                                                            {/*
                                                              The host, and not
                                                              a link: a stored
                                                              URL is never
                                                              fetched, and one
                                                              rendered as a
                                                              link invites
                                                              exactly that.
                                                            */}
                                                            {interpolate(
                                                                t(
                                                                    "assistantProfiles.provenanceHost"
                                                                ),
                                                                {
                                                                    host: entry.declaredSourceHost,
                                                                }
                                                            )}
                                                        </>
                                                    )}
                                                </p>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}

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
