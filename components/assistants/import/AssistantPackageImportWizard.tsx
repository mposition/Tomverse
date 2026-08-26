"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
    AlertTriangle,
    ArrowLeft,
    ArrowRight,
    Loader2,
    RotateCcw,
    Upload,
} from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import { ModelSelector } from "@/components/assistants/ModelSelector";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import {
    formatBytes,
    interpolate,
    primaryButtonClass,
    secondaryButtonClass,
    sectionClass,
} from "@/components/imports/importFormatting";
import type {
    ConversionLossKind,
    ImportFieldNote,
} from "@/lib/assistantPackageAdapter";
import {
    ASSISTANT_PACKAGE_LIMITS,
    packageEntryExtension,
    type AssistantPackageRefusalCode,
    type AssistantPackageSkipReason,
} from "@/lib/assistantPackageLimits";
import { knowledgeMimeForExtension } from "@/lib/assistantKnowledgeLimits";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { ENABLED_MODELS } from "@/lib/models";
import {
    ASSISTANT_PACKAGE_IMPORT_STEPS,
    IMPORT_APPROVAL_DIGEST_VERSION,
    IMPORT_FIELDS,
    IMPORT_STEP_COUNT,
    advanceProblems,
    assistantPackageImportReducer,
    canAdvance,
    canGoBack,
    importApprovalPayload,
    importStepNumber,
    initialImportState,
    keepFileIds,
    resolveImportDraft,
    resumableDraftFromManifest,
    unwaivedFindings,
    type AssistantPackageImportState,
    type AssistantPackageImportStep,
    type ImportBlock,
    type ImportFieldKey,
    type ImportMergeTarget,
    type ImportUploadFile,
    type ResumableImport,
} from "@/lib/assistantPackageImportWizard";
import {
    ImportRequestError,
    cancelImport,
    createImport,
    finalizeImportUpload,
    prepareImportUpload,
    publishImport,
    putImportObject,
    readImport,
    sha256Hex,
} from "@/lib/assistantPackageImportClient";
import { findingKey } from "@/lib/assistantPackageSecretScan";
import { trackProductEvent, trackProductEventOnce } from "@/lib/productAnalyticsClient";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import {
    ASSISTANT_PROFILE_LIST_PATH,
    assistantProfileHierarchy,
} from "@/lib/settingsNavigation";
import type { AssistantPackageReview } from "@/lib/assistantPackageReview";
import type { WorkerRequest, WorkerResponse } from "@/lib/workers/assistantPackageWorker";

/**
 * /settings/assistants/import — steps 1 to 6 of the package import wizard.
 *
 * docs/policy/assistant-package-import.md §5.
 *
 * The rules live in `lib/assistantPackageImportWizard.ts`; this component runs
 * the Web Worker and renders what the state machine decided. The split is the
 * one `ExternalImportWizard` uses, and it is why "may this step be left" is a
 * function a test can call rather than a disabled attribute.
 *
 * Two contracts this component is responsible for keeping:
 *
 *   * the container is opened by the worker and never uploaded. Steps 1 to 6
 *     make no request at all (§5.4), which is why there is no loading state
 *     here that is not the worker;
 *   * the 6 -> 7 boundary is stated before it is crossed. The owner ticks a
 *     box that says files start being stored, and `uploadAcknowledged` is
 *     state rather than a rendering detail so a redesign cannot lose it.
 *
 * Steps 7 and 8 run against the import endpoints, and the whole route stays
 * behind a flag that is off until the rollout is approved.
 *
 * `mergeTargets` arrives as a prop rather than being fetched here, and that is
 * the same contract from the other side: a list request made from step 6 would
 * be a request made before the boundary that says none has been made.
 *
 * The step bodies are local components rather than files of their own. Each is
 * short because the decisions are elsewhere -- unlike the external import's
 * steps, which carry a virtualized list and a provider guide -- and splitting
 * eight thirty-line renderers across eight files would spread one screen over
 * nine of them.
 *
 * Formatting helpers are imported from the external import's folder rather
 * than copied. They are pure and locale-agnostic by their own header, both
 * screens are full-page settings wizards, and two definitions of "what a
 * section looks like" is how two wizards stop looking like one product.
 */

/* --------------------------------------------------------- locale mapping */

// Keyed by the union rather than by `string`, so a new kind is a type error
// until somebody writes its sentence. That is the point: an unlabelled kind
// would otherwise render as nothing at all.
const STEP_LABEL_KEY: Record<AssistantPackageImportStep, string> = {
    source: "assistantPackageImport.stepSource",
    detect: "assistantPackageImport.stepDetect",
    inventory: "assistantPackageImport.stepInventory",
    fields: "assistantPackageImport.stepFields",
    losses: "assistantPackageImport.stepLosses",
    target: "assistantPackageImport.stepTarget",
    upload: "assistantPackageImport.stepUpload",
    confirm: "assistantPackageImport.stepConfirm",
};

const FIELD_LABEL_KEY: Record<ImportFieldKey, string> = {
    name: "assistantPackageImport.fieldName",
    icon: "assistantPackageImport.fieldIcon",
    description: "assistantPackageImport.fieldDescription",
    instructions: "assistantPackageImport.fieldInstructions",
    starters: "assistantPackageImport.fieldStarters",
    modelIds: "assistantPackageImport.fieldModelIds",
    toolPolicy: "assistantPackageImport.fieldToolPolicy",
    memoryPolicy: "assistantPackageImport.fieldMemoryPolicy",
};

const NOTE_KEY: Record<ImportFieldNote, string> = {
    name_is_a_slug: "assistantPackageImport.noteNameIsASlug",
    name_shortened: "assistantPackageImport.noteNameShortened",
    description_shortened: "assistantPackageImport.noteDescriptionShortened",
    read_the_instructions: "assistantPackageImport.noteReadTheInstructions",
    choose_a_model: "assistantPackageImport.noteChooseAModel",
    name_may_collide: "assistantPackageImport.noteNameMayCollide",
    confirm_models: "assistantPackageImport.noteConfirmModels",
};

/**
 * How many of a loss's items the report names before summarising the rest.
 *
 * Twenty is enough to recognise what a package dropped -- the common cases are
 * one or two files -- without turning the acknowledgement screen into a
 * directory listing.
 */
const LOSS_ITEMS_SHOWN = 20;

const LOSS_KEY: Record<ConversionLossKind, string> = {
    scripts: "assistantPackageImport.lossScripts",
    icon: "assistantPackageImport.lossIcon",
    model: "assistantPackageImport.lossModel",
    license_stated: "assistantPackageImport.lossLicenseStated",
    license_absent: "assistantPackageImport.lossLicenseAbsent",
    unknown_frontmatter: "assistantPackageImport.lossUnknownFrontmatter",
    allowed_tools: "assistantPackageImport.lossAllowedTools",
    relative_links: "assistantPackageImport.lossRelativeLinks",
    skipped_entries: "assistantPackageImport.lossSkippedEntries",
    knowledge_over_limit: "assistantPackageImport.lossKnowledgeOverLimit",
};

const SKIP_KEY: Record<AssistantPackageSkipReason, string> = {
    directory: "assistantPackageImport.skipDirectory",
    nested_archive: "assistantPackageImport.skipNestedArchive",
    executable_script: "assistantPackageImport.skipExecutableScript",
    unsupported_extension: "assistantPackageImport.skipUnsupportedExtension",
    media: "assistantPackageImport.skipMedia",
    empty: "assistantPackageImport.skipEmpty",
    over_knowledge_limit: "assistantPackageImport.skipOverKnowledgeLimit",
};

const REFUSAL_KEY: Record<AssistantPackageRefusalCode, string> = {
    ASSISTANT_PACKAGE_TOO_LARGE: "assistantPackageImport.refusalTooLarge",
    ASSISTANT_PACKAGE_TOO_MANY_ENTRIES: "assistantPackageImport.refusalTooManyEntries",
    ASSISTANT_PACKAGE_UNSAFE_ENTRY: "assistantPackageImport.refusalUnsafeEntry",
    ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED: "assistantPackageImport.refusalFormatUnsupported",
    ASSISTANT_PACKAGE_MANIFEST_INVALID: "assistantPackageImport.refusalManifestInvalid",
    ASSISTANT_PACKAGE_SCHEMA_VERSION_UNSUPPORTED:
        "assistantPackageImport.refusalSchemaVersionUnsupported",
    ASSISTANT_PACKAGE_INSTRUCTIONS_TOO_LONG:
        "assistantPackageImport.refusalInstructionsTooLong",
    ASSISTANT_PACKAGE_SECRET_PRESENT: "assistantPackageImport.refusalSecretPresent",
};

const UPLOAD_STATUS_KEY: Record<ImportUploadFile["status"], string> = {
    waiting: "assistantPackageImport.uploadStatusWaiting",
    uploading: "assistantPackageImport.uploadStatusUploading",
    processing: "assistantPackageImport.uploadStatusProcessing",
    ready: "assistantPackageImport.uploadStatusReady",
    failed: "assistantPackageImport.uploadStatusFailed",
};

/**
 * A sentence for a failure the server named.
 *
 * The known codes get their own line; anything else gets one that says the
 * import stopped without pretending to know why. The server's message is never
 * shown -- it is written for a developer and can name a path.
 */
const RUN_FAILURE_KEY: Record<string, string> = {
    ASSISTANT_PROFILE_VERSION_STALE: "assistantPackageImport.failureStale",
    ASSISTANT_PROFILE_IMPORT_IN_PROGRESS: "assistantPackageImport.failureInProgress",
    ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED: "assistantPackageImport.failureQuota",
    ASSISTANT_KNOWLEDGE_KEY_RESERVED_FOR_IMPORT:
        "assistantPackageImport.failureKeyInUse",
    ASSISTANT_PACKAGE_UPLOAD_FAILED: "assistantPackageImport.failureUpload",
    ASSISTANT_PACKAGE_ENTRY_MISSING: "assistantPackageImport.failureEntryMissing",
    ASSISTANT_PACKAGE_DOCUMENTS_NOT_READY: "assistantPackageImport.failureNotReady",
};

const runFailureKey = (code: string): string =>
    RUN_FAILURE_KEY[code] ?? "assistantPackageImport.failureGeneric";

/**
 * The warnings worth counting across many imports.
 *
 * Derived from the review rather than from the screen, so the count does not
 * depend on what the owner happened to scroll past. Each one is a closed enum
 * value and nothing else travels with it: a package carries somebody else's
 * filenames and instructions, and this is the boundary where those stop.
 */
const reviewWarnings = (
    review: AssistantPackageReview
): NonNullable<Parameters<typeof trackProductEvent>[2]>["package_import_warning"][] => {
    const warnings: string[] = [];
    if (review.secretFindings.length > 0) warnings.push("secret_finding");
    for (const loss of review.losses) {
        if (loss.kind === "scripts") warnings.push("scripts_skipped");
        if (loss.kind === "knowledge_over_limit") warnings.push("documents_over_limit");
        if (loss.kind === "license_absent") warnings.push("license_absent");
        if (loss.kind === "relative_links") warnings.push("relative_links");
    }
    return warnings as ReturnType<typeof reviewWarnings>;
};

/** Why a step cannot be left, for the kinds that carry no data of their own. */
const BLOCK_KEY: Record<ImportBlock["kind"], string> = {
    no_file: "assistantPackageImport.blockNoFile",
    parsing: "assistantPackageImport.blockParsing",
    package_refused: "assistantPackageImport.blockPackageRefused",
    unwaived_secret: "assistantPackageImport.secretBlocked",
    invalid_draft: "assistantPackageImport.problemGeneric",
    too_many_knowledge_files: "assistantPackageImport.blockTooManyKnowledgeFiles",
    losses_unacknowledged: "assistantPackageImport.blockLossesUnacknowledged",
    no_target: "assistantPackageImport.blockNoTarget",
    upload_unacknowledged: "assistantPackageImport.blockUploadUnacknowledged",
    run_failed: "assistantPackageImport.blockRunFailed",
    documents_pending: "assistantPackageImport.blockDocumentsPending",
    documents_failed: "assistantPackageImport.blockDocumentsFailed",
};

/**
 * A validator's field name to a sentence.
 *
 * The validators return English reasons for a developer; the owner gets a
 * sentence in their own language. `field` is the only part of a problem this
 * screen reads, and an unmapped field falls back to a general line rather than
 * rendering the English one.
 */
const PROBLEM_KEY: Record<string, string> = {
    name: "assistantPackageImport.problemName",
    icon: "assistantPackageImport.problemIcon",
    description: "assistantPackageImport.problemDescription",
    instructions: "assistantPackageImport.problemInstructions",
    modelIds: "assistantPackageImport.problemModelIds",
    starters: "assistantPackageImport.problemStarters",
};

/* ---------------------------------------------------------------- wizard */

const ACCEPT = ".zip,.json";

/**
 * How long step 7 watches before it stops asking.
 *
 * Two seconds is short enough that a small document looks immediate and long
 * enough that a hundred of them do not become a request per second. The cap is
 * ten minutes, which is past any extraction this accepts; reaching it leaves
 * the documents in whatever state the server last reported rather than
 * declaring a failure the server has not.
 */
const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 300;

export function AssistantPackageImportWizard({
    mergeTargets,
    resumable = [],
}: {
    /** The owner's existing assistants, read by the page. May be empty. */
    mergeTargets: readonly ImportMergeTarget[];
    /** Imports the server is still holding for this account. */
    resumable?: readonly ResumableImport[];
}) {
    const { t } = useLanguage();
    const router = useRouter();
    const [state, dispatch] = useReducer(
        assistantPackageImportReducer,
        undefined,
        initialImportState
    );
    const workerRef = useRef<Worker | null>(null);
    /**
     * The chosen file, kept out of the state machine.
     *
     * A `File` is not something a reducer should hold: it is not serialisable,
     * it cannot be compared, and the machine's whole value is that it can be
     * driven from a test. The run needs the bytes again at step 7 -- the
     * review carries none -- so the handle lives here instead.
     */
    const fileRef = useRef<File | null>(null);
    /**
     * The state as of this render, for the async run to read across awaits.
     *
     * The run loop spans several requests, so a closure over `state` would be
     * reading whatever was true when it started. It reads through here and
     * writes only by dispatching, so the reducer stays the only thing that
     * decides what the state becomes.
     */
    const stateRef = useRef(state);
    /** Set on unmount, so a poll in flight stops instead of dispatching. */
    const goneRef = useRef(false);
    /**
     * Whether a run or a publish is already in flight.
     *
     * A ref rather than the state, because the state this reads through is
     * updated in an effect and a second click can land before that runs. Two
     * runs would create two imports -- in `create` mode, two draft profiles --
     * and two publishes would race for the same revision.
     */
    const busyRef = useRef(false);
    /**
     * The step to report as abandoned, or `null` once there is nothing to
     * abandon. Read by the unmount handler, which cannot see the state.
     */
    const stepAtUnmountRef = useRef<AssistantPackageImportStep | null>(null);

    // In an effect rather than during render: writing a ref while rendering is
    // a write React may throw away, and the run reads this across awaits where
    // a discarded write would be a decision made from a state that never was.
    useEffect(() => {
        stateRef.current = state;
        // Nothing to abandon before a file is chosen, and nothing to abandon
        // once it is published.
        stepAtUnmountRef.current =
            state.file === null || state.run.kind === "published" ? null : state.step;
    }, [state]);

    /**
     * Each step, once, as it is reached.
     *
     * `trackProductEventOnce` rather than an effect that fires on every
     * render: going back and forward between two steps is one funnel position
     * visited twice, and counting it twice would make the drop-off between
     * consecutive steps read as negative.
     */
    useEffect(() => {
        trackProductEventOnce(
            `assistant-package-import-step:${state.step}`,
            "assistant_package_import_step_entered",
            0,
            { package_import_step: state.step }
        );
    }, [state.step]);

    useEffect(
        () => () => {
            goneRef.current = true;
            // A deliberate exit. A browser close is not observable here, so
            // `abandoned` counts are a floor rather than the real drop-off --
            // which is the difference between consecutive steps' `entered`
            // counts, exactly as the conversation import's funnel works.
            const step = stepAtUnmountRef.current;
            if (step !== null) {
                trackProductEvent("assistant_package_import_step_abandoned", 0, {
                    package_import_step: step,
                });
            }
            workerRef.current?.terminate();
            workerRef.current = null;
        },
        []
    );

    /** A worker for one request, ended when it answers. */
    const askWorker = useCallback(
        (request: WorkerRequest, onMessage: (message: WorkerResponse) => boolean) => {
            workerRef.current?.terminate();
            const worker = new Worker(
                new URL("../../../lib/workers/assistantPackageWorker.ts", import.meta.url),
                { type: "module" }
            );
            workerRef.current = worker;
            worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
                if (onMessage(event.data)) {
                    worker.terminate();
                    if (workerRef.current === worker) workerRef.current = null;
                }
            };
            worker.onerror = () => {
                onMessage({
                    type: "refused",
                    code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
                    cause: "parser_error",
                });
                worker.terminate();
                if (workerRef.current === worker) workerRef.current = null;
            };
            worker.postMessage(request);
            return worker;
        },
        []
    );

    const openPackage = useCallback(
        (file: File) => {
            fileRef.current = file;
            dispatch({
                type: "file_selected",
                file: { name: file.name, bytes: file.size },
            });
            askWorker({ type: "parse", file }, (message) => {
                if (message.type === "progress") {
                    dispatch({
                        type: "parse_progress",
                        entriesRead: message.entriesRead,
                        entriesPlanned: message.entriesPlanned,
                    });
                    return false;
                }
                if (message.type === "review") {
                    dispatch({ type: "parse_succeeded", review: message.review });
                    // One event per warning kind, when the package is read
                    // rather than when a screen renders it: what is being
                    // counted is what packages contain, not what anybody
                    // scrolled past.
                    for (const warning of reviewWarnings(message.review)) {
                        trackProductEvent("assistant_package_import_warning", 0, {
                            package_import_warning: warning,
                        });
                    }
                } else if (message.type === "refused") {
                    dispatch({
                        type: "parse_refused",
                        code: message.code,
                        cause: message.cause,
                    });
                    trackProductEvent("assistant_package_import_warning", 0, {
                        package_import_warning: "package_refused",
                    });
                }
                return true;
            });
        },
        [askWorker]
    );

    /** The bytes of the chosen documents, asked for once, at upload time. */
    const extractSelected = useCallback(
        (file: File, paths: string[]) =>
            new Promise<{ path: string; bytes: Uint8Array }[]>((resolve, reject) => {
                askWorker({ type: "extract", file, paths }, (message) => {
                    if (message.type === "extracted") {
                        resolve(message.entries);
                        return true;
                    }
                    if (message.type === "refused") {
                        reject(new ImportRequestError(0, message.code));
                        return true;
                    }
                    return false;
                });
            }),
        [askWorker]
    );

    /**
     * Steps 7 and 8's first half: create the import, send the documents, and
     * watch until the server has read them all.
     *
     * The order is the contract. The import row exists before any object does,
     * so every stored byte has something accounting for it; each document is
     * prepared, put and finalized one at a time, because a failure halfway
     * through a batch would leave objects nothing has claimed; and the wait is
     * a poll of the import rather than of each file, so "all of them are
     * ready" is answered by the server that owns it.
     */
    const runImport = useCallback(async () => {
        const file = fileRef.current;
        const current = stateRef.current;
        const target = current.target;
        if (!file || !current.review || !target || busyRef.current) return;

        busyRef.current = true;
        dispatch({ type: "run_started" });
        try {
            const draft = resolveImportDraft(current);
            const chosen = current.review.knowledgeCandidates.filter((candidate) =>
                current.knowledgeSelection.includes(candidate.path)
            );

            const created = await createImport({
                // The wizard calls the first case "new" because that is what
                // the owner chose; the server calls it "create" because that
                // is what it does. Translated here rather than renaming
                // either -- both words are right where they are.
                mode: target.kind === "new" ? "create" : "merge",
                targetProfileId:
                    target.kind === "merge" ? target.profileId : undefined,
                identity: {
                    name: draft.name,
                    icon: draft.icon,
                    description: draft.description,
                },
                // Enough to resume an interrupted import, and no more: the
                // container is not kept, so this is the only record of what
                // the owner assembled.
                stagingManifest: {
                    kind: current.review.kind,
                    adapterVersion: current.review.adapterVersion,
                    draft,
                    documents: chosen.map((candidate) => ({
                        name: candidate.name,
                        bytes: candidate.bytes,
                        digest: candidate.digest,
                    })),
                },
                declared: {
                    sourceKind: current.review.declaredProvenance?.sourceKind ?? null,
                    sourceName: current.review.declaredProvenance?.sourceName ?? null,
                    sourceUrl: current.review.declaredProvenance?.sourceUrl ?? null,
                    previousProvenance: null,
                },
            });
            if (goneRef.current) return;

            const uploads: ImportUploadFile[] = chosen.map((candidate) => ({
                path: candidate.path,
                name: candidate.name,
                status: "waiting",
                fileId: null,
                failureCode: null,
            }));
            dispatch({ type: "import_created", importId: created.id, uploads });

            const bytesByPath = new Map(
                (await extractSelected(
                    file,
                    chosen.map((candidate) => candidate.path)
                )).map((entry) => [entry.path, entry.bytes])
            );
            if (goneRef.current) return;

            for (const candidate of chosen) {
                const bytes = bytesByPath.get(candidate.path);
                if (!bytes) {
                    // The container no longer holds what the review described.
                    // Refusing beats uploading something else under a name the
                    // owner already approved.
                    dispatch({
                        type: "upload_progressed",
                        path: candidate.path,
                        status: "failed",
                        failureCode: "ASSISTANT_PACKAGE_ENTRY_MISSING",
                    });
                    continue;
                }
                // Derived from the name, because a document out of an archive
                // has no browser to report its type. The knowledge table is
                // the one authority for the mapping, and the server checks the
                // bytes regardless of what this says.
                const mime = knowledgeMimeForExtension(
                    packageEntryExtension(candidate.name)
                );
                if (mime === null) {
                    dispatch({
                        type: "upload_progressed",
                        path: candidate.path,
                        status: "failed",
                        failureCode: "ASSISTANT_PACKAGE_UNSUPPORTED_DOCUMENT",
                    });
                    continue;
                }
                dispatch({
                    type: "upload_progressed",
                    path: candidate.path,
                    status: "uploading",
                });
                const prepared = await prepareImportUpload(created.id, {
                    filename: candidate.name,
                    mime,
                    bytes: bytes.byteLength,
                });
                await putImportObject({
                    uploadUrl: prepared.uploadUrl,
                    uploadHeaders: prepared.uploadHeaders,
                    bytes,
                    mime,
                });
                const stored = await finalizeImportUpload(created.id, {
                    uploadKey: prepared.uploadKey,
                    filename: candidate.name,
                    mime,
                });
                if (goneRef.current) return;
                dispatch({
                    type: "upload_progressed",
                    path: candidate.path,
                    status: "processing",
                    fileId: stored.id,
                });
            }

            // Watching the import rather than each file: "every document is
            // ready" is a fact about the import, and the server is the one
            // that holds it.
            for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
                if (goneRef.current) return;
                const snapshot = await readImport(created.id);
                dispatch({ type: "processing_observed", files: snapshot.files });
                if (snapshot.ready) {
                    dispatch({ type: "advanced" });
                    return;
                }
                if (
                    snapshot.files.some((entry) => entry.processingStatus === "failed")
                ) {
                    trackProductEventOnce(
                        `assistant-package-import-unreadable:${created.id}`,
                        "assistant_package_import_warning",
                        0,
                        { package_import_warning: "document_unreadable" }
                    );
                    // Stop watching, but do not fail the run: a document that
                    // could not be read is the owner's decision to make.
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            }
        } catch (error) {
            if (goneRef.current) return;
            dispatch({
                type: "run_failed",
                code:
                    error instanceof ImportRequestError
                        ? error.code
                        : "ASSISTANT_PACKAGE_IMPORT_FAILED",
            });
        } finally {
            busyRef.current = false;
        }
    }, [extractSelected]);

    /**
     * Taking the import back.
     *
     * The only way out from step 7 onward, and it has to exist: a document
     * that could not be read stops the step, and going back is not available
     * once anything is stored. Without this the owner would be left holding
     * staged files with nothing to do about them.
     */
    const cancelRun = useCallback(async () => {
        const current = stateRef.current;
        const importId =
            "importId" in current.run ? (current.run.importId as string | null) : null;
        try {
            if (importId) await cancelImport(importId);
        } catch {
            // A cancellation that could not be delivered is not worth a second
            // error screen: the expiry sweep takes an abandoned import anyway,
            // and the owner's intent was to leave.
        }
        if (goneRef.current) return;
        busyRef.current = false;
        dispatch({ type: "restarted" });
    }, []);

    /**
     * Picking an import the server is still holding.
     *
     * Everything comes from the server: the draft from the manifest it stored,
     * the documents from the rows it holds. Nothing is reconstructed from the
     * container, because the container is gone -- which is exactly why this
     * had to exist.
     */
    const [resumeBusyId, setResumeBusyId] = useState<string | null>(null);
    const [resumeFailed, setResumeFailed] = useState<string | null>(null);

    const resumeImport = useCallback(async (waiting: ResumableImport) => {
        if (busyRef.current) return;
        setResumeFailed(null);
        setResumeBusyId(waiting.id);
        try {
            const snapshot = await readImport(waiting.id);
            const draft = resumableDraftFromManifest(snapshot.stagingManifest);
            if (!draft) {
                // Cancelling is still offered, so an import this build cannot
                // read is not a dead end either.
                setResumeFailed(waiting.id);
                return;
            }
            dispatch({
                type: "resumed",
                importId: snapshot.id,
                target:
                    waiting.mode === "merge"
                        ? { kind: "merge", profileId: waiting.profileId }
                        : { kind: "new" },
                draft,
                uploads: snapshot.files.map((file) => ({
                    // The container path was this file's identity while the
                    // archive was open. It is not recoverable here and nothing
                    // downstream needs it, so the server's id stands in --
                    // unique, and stable across the polls that follow.
                    path: file.id,
                    name: file.name,
                    status:
                        file.processingStatus === "ready"
                            ? "ready"
                            : file.processingStatus === "failed"
                              ? "failed"
                              : "processing",
                    fileId: file.id,
                    failureCode: file.failureCode,
                })),
            });
        } catch {
            setResumeFailed(waiting.id);
        } finally {
            if (!goneRef.current) setResumeBusyId(null);
        }
    }, []);

    /**
     * Letting go of one without opening it.
     *
     * The exit that was missing. In `create` mode an abandoned import could be
     * cleared by deleting the draft profile it made; in `merge` mode the
     * profile is one the owner uses, so there was nothing to do but wait out
     * the idle sweep while ordinary publishing stayed refused.
     */
    const cancelStagedImport = useCallback(async (waiting: ResumableImport) => {
        if (busyRef.current) return;
        setResumeFailed(null);
        setResumeBusyId(waiting.id);
        try {
            await cancelImport(waiting.id);
            if (!goneRef.current) router.refresh();
        } catch {
            setResumeFailed(waiting.id);
        } finally {
            if (!goneRef.current) setResumeBusyId(null);
        }
    }, [router]);

    /** Step 8: the one action on the screen, and the only one that publishes. */
    const publish = useCallback(async () => {
        const current = stateRef.current;
        if (current.run.kind !== "ready" || busyRef.current) return;
        const importId = current.run.importId;
        busyRef.current = true;
        dispatch({ type: "publish_started" });
        try {
            const draft = resolveImportDraft(current);
            const outcome = await publishImport(importId, {
                approvedDigest: await sha256Hex(importApprovalPayload(current)),
                digestVersion: IMPORT_APPROVAL_DIGEST_VERSION,
                keepFileIds: keepFileIds(current),
                identity: {
                    name: draft.name,
                    icon: draft.icon,
                    description: draft.description,
                },
                draft: {
                    instructions: draft.instructions,
                    modelIds: draft.modelIds,
                    toolPolicy: draft.toolPolicy,
                    memoryPolicy: draft.memoryPolicy,
                    starters: draft.starters,
                },
            });
            if (goneRef.current) return;
            if (outcome.outcome === "not_ready") {
                dispatch({
                    type: "run_failed",
                    code: "ASSISTANT_PACKAGE_DOCUMENTS_NOT_READY",
                });
                return;
            }
            trackProductEvent("assistant_package_import_completed", 0, {
                // What the parser read the package as, never what it claimed
                // to be: the claim is display-only and this is a measurement.
                package_import_source:
                    current.review?.kind === "tomverse-native"
                        ? "tomverse-native"
                        : "agent-skill",
            });
            dispatch({
                type: "publish_succeeded",
                revision:
                    outcome.outcome === "published"
                        ? outcome.version.revision
                        : outcome.revision,
                unchanged: outcome.outcome === "unchanged",
            });
        } catch (error) {
            if (goneRef.current) return;
            dispatch({
                type: "run_failed",
                code:
                    error instanceof ImportRequestError
                        ? error.code
                        : "ASSISTANT_PACKAGE_PUBLISH_FAILED",
            });
        } finally {
            busyRef.current = false;
        }
    }, []);

    const review = state.review;
    const blocks = advanceProblems(state);
    const stepIndex = importStepNumber(state.step);

    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <SettingsDetailNav
                hierarchy={assistantProfileHierarchy()}
                currentLabel={t("assistantPackageImport.title")}
                backTestId="assistant-package-import-back"
            />

            <header className="mt-6">
                <h1 className="text-xl font-semibold">
                    {t("assistantPackageImport.title")}
                </h1>
                <p className="mt-1 text-sm text-zinc-500">
                    {t("assistantPackageImport.subtitle")}
                </p>
            </header>

            <ol
                className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500"
                data-testid="assistant-package-import-steps"
            >
                {ASSISTANT_PACKAGE_IMPORT_STEPS.map((step, index) => (
                    <li
                        key={step}
                        aria-current={step === state.step ? "step" : undefined}
                        className={
                            step === state.step
                                ? "font-semibold text-zinc-900 dark:text-zinc-100"
                                : undefined
                        }
                    >
                        {index + 1}. {t(STEP_LABEL_KEY[step])}
                    </li>
                ))}
            </ol>
            <p className="mt-1 text-xs text-zinc-500">
                {interpolate(t("assistantPackageImport.stepCounter"), {
                    current: stepIndex,
                    total: IMPORT_STEP_COUNT,
                })}
            </p>

            <div className="mt-5 flex flex-col gap-4">
                {state.step === "source" && (
                    <>
                        {/*
                          Before the file picker, because an import already
                          staged is the thing to deal with first: starting a
                          second one against the same assistant is refused at
                          step 7, and the owner would find that out after
                          reviewing a whole package.
                        */}
                        {state.file === null && resumable.length > 0 && (
                            <ResumeStep
                                resumable={resumable}
                                busyId={resumeBusyId}
                                failed={resumeFailed}
                                onResume={resumeImport}
                                onCancel={cancelStagedImport}
                                t={t}
                            />
                        )}
                        <SourceStep state={state} onFile={openPackage} t={t} />
                    </>
                )}
                {state.step === "detect" && <DetectStep state={state} t={t} />}
                {state.step === "inventory" && (
                    <InventoryStep state={state} dispatch={dispatch} t={t} />
                )}
                {state.step === "fields" && (
                    <FieldsStep state={state} dispatch={dispatch} t={t} />
                )}
                {state.step === "losses" && (
                    <LossesStep state={state} dispatch={dispatch} t={t} />
                )}
                {state.step === "target" && (
                    <TargetStep
                        state={state}
                        dispatch={dispatch}
                        mergeTargets={mergeTargets}
                        t={t}
                    />
                )}
                {state.step === "upload" && (
                    <UploadStep state={state} onCancel={cancelRun} t={t} />
                )}
                {state.step === "confirm" && (
                    <ConfirmStep
                        state={state}
                        onPublish={publish}
                        onCancel={cancelRun}
                        mergeTargets={mergeTargets}
                        t={t}
                    />
                )}
                {blocks.length > 0 && review && (
                    <ul
                        className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-400"
                        data-testid="assistant-package-import-blocks"
                    >
                        {blocks.map((block, index) => (
                            <li key={`${block.kind}-${index}`}>
                                {block.kind === "invalid_draft"
                                    ? t(
                                          PROBLEM_KEY[block.problem.field] ??
                                              "assistantPackageImport.problemGeneric"
                                      )
                                    : block.kind === "unwaived_secret"
                                      ? interpolate(
                                            t("assistantPackageImport.secretBlocked"),
                                            { count: block.count }
                                        )
                                      : t(BLOCK_KEY[block.kind])}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <nav className="mt-6 flex items-center justify-between gap-3">
                <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={!canGoBack(state)}
                    onClick={() => dispatch({ type: "went_back" })}
                    data-testid="assistant-package-import-previous"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    {t("assistantPackageImport.back")}
                </button>
                <button
                    type="button"
                    className={primaryButtonClass}
                    // Step 8 has no next: publishing is its own control, and a
                    // second way to trigger the one irreversible thing on the
                    // screen is a second way to do it by accident.
                    disabled={!canAdvance(state) || state.step === "confirm"}
                    onClick={() => {
                        if (state.step === "target") {
                            // Crossing the boundary advances *and* starts the
                            // run: the step and the work are the same event,
                            // and separating them would let one happen without
                            // the other.
                            dispatch({ type: "advanced" });
                            void runImport();
                            return;
                        }
                        dispatch({ type: "advanced" });
                    }}
                    data-testid="assistant-package-import-next"
                >
                    {t("assistantPackageImport.next")}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
            </nav>
        </div>
    );
}

/* ------------------------------------------------------------- the steps */

type Translate = (key: string) => string;
type WizardState = AssistantPackageImportState;
type Dispatch = (action: Parameters<typeof assistantPackageImportReducer>[1]) => void;

/**
 * Imports the server is still holding, offered before the file picker.
 *
 * The wizard keeps nothing across page loads, so a tab closed at step 7 or 8
 * left its import unreachable: `create` mode could be cleared by deleting the
 * draft profile it made, but `merge` mode stages into a profile the owner
 * uses, and that profile then refuses ordinary publishing until the 24-hour
 * idle sweep. Two controls, because the two answers are different: carry on
 * with it, or let it go.
 */
function ResumeStep({
    resumable,
    busyId,
    failed,
    onResume,
    onCancel,
    t,
}: {
    resumable: readonly ResumableImport[];
    busyId: string | null;
    failed: string | null;
    onResume: (waiting: ResumableImport) => void;
    onCancel: (waiting: ResumableImport) => void;
    t: Translate;
}) {
    return (
        <section
            className={`${sectionClass} border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40`}
            data-testid="assistant-package-import-resume"
        >
            <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {t("assistantPackageImport.resumeHeading")}
            </h2>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                {t("assistantPackageImport.resumeBody")}
            </p>
            <ul className="mt-3 flex flex-col gap-2">
                {resumable.map((waiting) => (
                    <li
                        key={waiting.id}
                        className="flex flex-wrap items-center gap-2 text-sm"
                    >
                        <span className="flex-1">
                            {interpolate(
                                t(
                                    waiting.mode === "merge"
                                        ? "assistantPackageImport.resumeMerge"
                                        : "assistantPackageImport.resumeCreate"
                                ),
                                {
                                    name: waiting.profileName,
                                    count: waiting.fileCount,
                                }
                            )}
                        </span>
                        <button
                            type="button"
                            className={secondaryButtonClass}
                            disabled={busyId !== null}
                            onClick={() => onResume(waiting)}
                            data-testid={`assistant-package-import-resume-${waiting.id}`}
                        >
                            {t("assistantPackageImport.resumeContinue")}
                        </button>
                        <button
                            type="button"
                            className={secondaryButtonClass}
                            disabled={busyId !== null}
                            onClick={() => onCancel(waiting)}
                            data-testid={`assistant-package-import-resume-cancel-${waiting.id}`}
                        >
                            {t("assistantPackageImport.runCancel")}
                        </button>
                    </li>
                ))}
            </ul>
            {failed !== null && (
                <p
                    className="mt-2 text-sm text-amber-800 dark:text-amber-300"
                    data-testid="assistant-package-import-resume-failed"
                >
                    {t("assistantPackageImport.resumeFailed")}
                </p>
            )}
        </section>
    );
}

function SourceStep({
    state,
    onFile,
    t,
}: {
    state: WizardState;
    onFile: (file: File) => void;
    t: Translate;
}) {
    return (
        <section className={sectionClass}>
            <h2 className="text-sm font-semibold">
                {t("assistantPackageImport.sourceHeading")}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
                {t("assistantPackageImport.sourceBody")}
            </p>
            {/*
              There is no address box, and there never will be one: §1.1 makes
              fetching a remote package a prohibition rather than an omission,
              so the reason is stated where somebody would look for the field.
            */}
            <p className="mt-2 text-xs text-zinc-500">
                {t("assistantPackageImport.sourceNoRemote")}
            </p>
            <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-blue-600">
                <Upload className="h-4 w-4" aria-hidden="true" />
                {t("assistantPackageImport.sourceChoose")}
                <input
                    type="file"
                    accept={ACCEPT}
                    className="sr-only"
                    data-testid="assistant-package-import-file"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) onFile(file);
                        event.target.value = "";
                    }}
                />
            </label>
            {state.file && (
                <p className="mt-3 text-sm" data-testid="assistant-package-import-file-name">
                    {state.file.name} · {formatBytes(state.file.bytes)}
                </p>
            )}
            {state.parse.kind === "parsing" && (
                <p className="mt-2 flex items-center gap-2 text-sm text-zinc-500">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {interpolate(t("assistantPackageImport.sourceParsing"), {
                        read: state.parse.entriesRead,
                        planned: state.parse.entriesPlanned,
                    })}
                </p>
            )}
        </section>
    );
}

function DetectStep({ state, t }: { state: WizardState; t: Translate }) {
    if (state.parse.kind === "refused") {
        return (
            <section
                className={sectionClass}
                data-testid="assistant-package-import-refused"
            >
                <h2 className="flex items-center gap-2 text-sm font-semibold text-red-600">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    {t("assistantPackageImport.detectRefusedHeading")}
                </h2>
                <p className="mt-1 text-sm">{t(REFUSAL_KEY[state.parse.code])}</p>
                {/*
                  The machine-readable cause is not shown. It names an entry
                  disposition or a header field, which tells the owner nothing
                  and can echo a path back at them (§9).
                */}
            </section>
        );
    }
    const review = state.review;
    if (!review) return null;
    return (
        <section className={sectionClass} data-testid="assistant-package-import-detected">
            <h2 className="text-sm font-semibold">
                {t("assistantPackageImport.detectHeading")}
            </h2>
            <p className="mt-1 text-sm">
                {t(
                    review.kind === "tomverse-native"
                        ? "assistantPackageImport.detectNative"
                        : "assistantPackageImport.detectSkill"
                )}
            </p>
            {review.declaredProvenance && (
                <p className="mt-2 text-xs text-zinc-500">
                    {t("assistantPackageImport.detectDeclaredProvenance")}
                </p>
            )}
        </section>
    );
}

function InventoryStep({
    state,
    dispatch,
    t,
}: {
    state: WizardState;
    dispatch: Dispatch;
    t: Translate;
}) {
    const review = state.review;
    if (!review) return null;
    const unwaived = unwaivedFindings(state);
    const waived = new Set(state.secretWaivers.map(findingKey));
    return (
        <>
            <section className={sectionClass}>
                <h2 className="text-sm font-semibold">
                    {t("assistantPackageImport.inventoryKnowledgeHeading")}
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                    {interpolate(t("assistantPackageImport.inventoryKnowledgeLimit"), {
                        limit: ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles,
                    })}
                </p>
                {review.knowledgeCandidates.length === 0 ? (
                    <p className="mt-2 text-sm text-zinc-500">
                        {t("assistantPackageImport.inventoryKnowledgeEmpty")}
                    </p>
                ) : (
                    <ul className="mt-2 flex flex-col gap-1">
                        {review.knowledgeCandidates.map((candidate) => (
                            <li key={candidate.path}>
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={state.knowledgeSelection.includes(
                                            candidate.path
                                        )}
                                        onChange={() =>
                                            dispatch({
                                                type: "knowledge_toggled",
                                                path: candidate.path,
                                            })
                                        }
                                        data-testid={`assistant-package-knowledge-${candidate.name}`}
                                    />
                                    <span>
                                        {candidate.name} · {formatBytes(candidate.bytes)}
                                    </span>
                                </label>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {review.skips.length > 0 && (
                <section className={sectionClass}>
                    <h2 className="text-sm font-semibold">
                        {t("assistantPackageImport.inventorySkippedHeading")}
                    </h2>
                    <ul className="mt-2 flex flex-col gap-1 text-sm text-zinc-500">
                        {review.skips.map((skip) => (
                            <li key={skip.path}>
                                {skip.path} — {t(SKIP_KEY[skip.reason])}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {review.instructionUrls.count > 0 && (
                <section className={sectionClass}>
                    <h2 className="text-sm font-semibold">
                        {t("assistantPackageImport.inventoryUrlHeading")}
                    </h2>
                    <p className="mt-1 text-sm text-zinc-500">
                        {t("assistantPackageImport.inventoryUrlBody")}
                    </p>
                    {/* Hosts, never the URLs: a path can carry a token (A6). */}
                    <p className="mt-2 text-sm">{review.instructionUrls.hosts.join(", ")}</p>
                </section>
            )}

            {review.secretFindings.length > 0 && (
                <section
                    className={sectionClass}
                    data-testid="assistant-package-import-secrets"
                >
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        {t("assistantPackageImport.inventorySecretHeading")}
                    </h2>
                    <p className="mt-1 text-sm text-zinc-500">
                        {t("assistantPackageImport.inventorySecretBody")}
                    </p>
                    <ul className="mt-2 flex flex-col gap-2">
                        {review.secretFindings.map((finding) => {
                            const key = findingKey(finding);
                            const isWaived = waived.has(key);
                            return (
                                <li key={key} className="flex items-center gap-2 text-sm">
                                    {/*
                                      The finding names where it is, never what
                                      it is: the matched text is not in the
                                      finding and must not be reconstructed for
                                      display.
                                    */}
                                    <span className="flex-1">{finding.source}</span>
                                    <button
                                        type="button"
                                        className={secondaryButtonClass}
                                        onClick={() =>
                                            dispatch(
                                                isWaived
                                                    ? { type: "secret_unwaived", finding }
                                                    : { type: "secret_waived", finding }
                                            )
                                        }
                                    >
                                        {t(
                                            isWaived
                                                ? "assistantPackageImport.secretUndo"
                                                : "assistantPackageImport.secretWaive"
                                        )}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {unwaived.length > 0 && (
                        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                            {interpolate(t("assistantPackageImport.secretBlocked"), {
                                count: unwaived.length,
                            })}
                        </p>
                    )}
                </section>
            )}
        </>
    );
}

function FieldsStep({
    state,
    dispatch,
    t,
}: {
    state: WizardState;
    dispatch: Dispatch;
    t: Translate;
}) {
    const review = state.review;
    if (!review) return null;
    const draft = resolveImportDraft(state);
    const noteFor = (key: ImportFieldKey): ImportFieldNote | null => {
        switch (key) {
            case "name":
                return review.identity.name.note;
            case "description":
                return review.identity.description.note;
            case "icon":
                return review.identity.icon.note;
            case "instructions":
                return review.instructions.note;
            case "starters":
                return review.starters.note;
            case "modelIds":
                return review.modelIds.note;
            case "toolPolicy":
                return review.toolPolicy.note;
            case "memoryPolicy":
                return review.memoryPolicy.note;
            default:
                return null;
        }
    };

    return (
        <section className={sectionClass} data-testid="assistant-package-import-fields">
            <h2 className="text-sm font-semibold">
                {t("assistantPackageImport.fieldsHeading")}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
                {t("assistantPackageImport.fieldsBody")}
            </p>
            <div className="mt-3 flex flex-col gap-4">
                {IMPORT_FIELDS.map((field) => {
                    const note = noteFor(field.key);
                    const decision = state.decisions[field.key];
                    return (
                        <div key={field.key} className="flex flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold">
                                    {t(FIELD_LABEL_KEY[field.key])}
                                </span>
                                {(["use", "edit", "exclude"] as const)
                                    .filter(
                                        (option) =>
                                            option !== "exclude" || field.excludable
                                    )
                                    .map((option) => (
                                        <button
                                            key={option}
                                            type="button"
                                            aria-pressed={decision === option}
                                            className={
                                                decision === option
                                                    ? primaryButtonClass
                                                    : secondaryButtonClass
                                            }
                                            onClick={() =>
                                                dispatch({
                                                    type: "field_decided",
                                                    field: field.key,
                                                    decision: option,
                                                })
                                            }
                                            data-testid={`assistant-package-field-${field.key}-${option}`}
                                        >
                                            {t(
                                                option === "use"
                                                    ? "assistantPackageImport.decisionUse"
                                                    : option === "edit"
                                                      ? "assistantPackageImport.decisionEdit"
                                                      : "assistantPackageImport.decisionExclude"
                                            )}
                                        </button>
                                    ))}
                            </div>
                            {note && (
                                <p className="text-xs text-amber-700 dark:text-amber-400">
                                    {t(NOTE_KEY[note])}
                                </p>
                            )}
                            <FieldEditor
                                fieldKey={field.key}
                                draft={draft}
                                editable={decision === "edit"}
                                dispatch={dispatch}
                                t={t}
                            />
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function FieldEditor({
    fieldKey,
    draft,
    editable,
    dispatch,
    t,
}: {
    fieldKey: ImportFieldKey;
    draft: ReturnType<typeof resolveImportDraft>;
    editable: boolean;
    dispatch: Dispatch;
    t: Translate;
}) {
    const inputClass =
        "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm disabled:bg-zinc-50 disabled:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:disabled:bg-zinc-900/60";

    if (fieldKey === "modelIds") {
        // The editor's control, mode and all. A package names no Tomverse
        // model, so "this assistant names none of its own" is the answer the
        // import most often has -- and it is an answer the profile validator
        // accepts, which is why it must be sayable here rather than refused.
        //
        // The mode is read from the list rather than stored: an empty list is
        // `account-default` and a non-empty one is `explicit`, and switching to
        // explicit seeds a model in the same move, so the derived value is
        // never the one the owner did not pick. The last tick cannot be
        // removed inside `explicit`, so the two states stay distinguishable
        // without a second field to keep in step with this one.
        const seed =
            ENABLED_MODELS.find(
                (model) => model.id === APP_DEFAULTS.defaultModelId
            ) ?? ENABLED_MODELS[0];
        const setModelIds = (next: string[]) =>
            dispatch({ type: "field_edited", edits: { modelIds: next } });
        return (
            <ModelSelector
                label={t("assistantPackageImport.fieldModelIds")}
                hint={t("assistantPackageImport.fieldModelIdsHint")}
                mode={draft.modelIds.length > 0 ? "explicit" : "account-default"}
                onModeChange={(next) =>
                    setModelIds(
                        next === "explicit" && seed ? [seed.id] : []
                    )
                }
                selected={draft.modelIds}
                onChange={setModelIds}
                t={t}
                testIdPrefix="assistant-package"
            />
        );
    }
    if (fieldKey === "toolPolicy" || fieldKey === "memoryPolicy") {
        // Booleans a package can ask for and this app decides. Shown, not
        // edited here: turning them on belongs to the profile's own screen,
        // where the plan and the account settings that also gate them are.
        const summary =
            fieldKey === "toolPolicy"
                ? `${draft.toolPolicy.webSearch}/${draft.toolPolicy.deepResearch}`
                : String(draft.memoryPolicy.useAccountMemory);
        return (
            <p className="text-xs text-zinc-500" data-testid={`assistant-package-field-${fieldKey}-value`}>
                {summary}
            </p>
        );
    }
    if (fieldKey === "instructions") {
        return (
            <textarea
                className={`${inputClass} min-h-32`}
                value={draft.instructions}
                disabled={!editable}
                maxLength={ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters}
                onChange={(event) =>
                    dispatch({
                        type: "field_edited",
                        edits: { instructions: event.target.value },
                    })
                }
                data-testid="assistant-package-field-instructions-value"
            />
        );
    }
    if (fieldKey === "starters") {
        return (
            <p className="text-xs text-zinc-500" data-testid="assistant-package-field-starters-value">
                {draft.starters.length === 0
                    ? t("assistantPackageImport.startersNone")
                    : draft.starters.join(" · ")}
            </p>
        );
    }

    const value =
        fieldKey === "name"
            ? draft.name
            : fieldKey === "icon"
              ? (draft.icon ?? "")
              : (draft.description ?? "");
    const maxLength =
        fieldKey === "name"
            ? ASSISTANT_PROFILE_LIMITS.maxNameCharacters
            : fieldKey === "icon"
              ? ASSISTANT_PROFILE_LIMITS.maxIconCharacters
              : ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters;

    return (
        <input
            className={inputClass}
            value={value}
            disabled={!editable}
            maxLength={maxLength}
            onChange={(event) =>
                dispatch({
                    type: "field_edited",
                    edits: { [fieldKey]: event.target.value },
                })
            }
            data-testid={`assistant-package-field-${fieldKey}-value`}
        />
    );
}

function LossesStep({
    state,
    dispatch,
    t,
}: {
    state: WizardState;
    dispatch: Dispatch;
    t: Translate;
}) {
    const losses = state.review?.losses ?? [];
    return (
        <section className={sectionClass} data-testid="assistant-package-import-losses">
            <h2 className="text-sm font-semibold">
                {t("assistantPackageImport.lossesHeading")}
            </h2>
            {losses.length === 0 ? (
                <p className="mt-1 text-sm text-zinc-500">
                    {t("assistantPackageImport.lossesNone")}
                </p>
            ) : (
                <>
                    <ul className="mt-2 flex flex-col gap-2 text-sm">
                        {losses.map((loss, index) => (
                            <li key={`${loss.kind}-${index}`}>
                                <p>
                                    {interpolate(t(LOSS_KEY[loss.kind]), {
                                        count: loss.count ?? 0,
                                        limit: ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles,
                                    })}
                                </p>
                                {loss.items && loss.items.length > 0 && (
                                    <p className="text-xs text-zinc-500">
                                        {/*
                                          Named, but bounded. A package may
                                          hold up to `maxEntries` entries and
                                          skip nearly all of them, and a line
                                          listing two thousand paths is a wall
                                          rather than a disclosure. The
                                          remainder is stated rather than
                                          dropped: a list that quietly stops
                                          reads as the whole list.
                                        */}
                                        {loss.items
                                            .slice(0, LOSS_ITEMS_SHOWN)
                                            .join(", ")}
                                        {loss.items.length > LOSS_ITEMS_SHOWN && (
                                            <>
                                                {" "}
                                                {interpolate(
                                                    t(
                                                        "assistantPackageImport.lossItemsMore"
                                                    ),
                                                    {
                                                        count:
                                                            loss.items.length -
                                                            LOSS_ITEMS_SHOWN,
                                                    }
                                                )}
                                            </>
                                        )}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                    <label className="mt-3 flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={state.lossesAcknowledged}
                            onChange={(event) =>
                                dispatch({
                                    type: "losses_acknowledged",
                                    acknowledged: event.target.checked,
                                })
                            }
                            data-testid="assistant-package-import-losses-ack"
                        />
                        {t("assistantPackageImport.lossesAcknowledge")}
                    </label>
                </>
            )}
        </section>
    );
}

/**
 * Step 6. A new assistant, or a revision of one that exists.
 *
 * Merging is the destructive-looking half, so what it does is stated on the
 * screen that offers it rather than at the end: the new revision carries what
 * was reviewed here, and the documents the assistant already has stay attached
 * to it without being named by that revision. Both are consequences the owner
 * cannot see from the word "merge", and neither can be undone by going back
 * once step 8 has run.
 *
 * A profile that has never been published is offered too. It is a legitimate
 * target -- the merge publishes its first revision -- and hiding it would be
 * this screen inventing a rule the server does not have. If it is a profile
 * another import is already staging into, the server refuses at step 7 with a
 * code this wizard renders.
 */
function TargetStep({
    state,
    dispatch,
    mergeTargets,
    t,
}: {
    state: WizardState;
    dispatch: Dispatch;
    mergeTargets: readonly ImportMergeTarget[];
    t: Translate;
}) {
    const target = state.target;
    return (
        <section className={sectionClass} data-testid="assistant-package-import-target">
            <h2 className="text-sm font-semibold">
                {t("assistantPackageImport.targetHeading")}
            </h2>
            <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                    type="radio"
                    name="assistant-package-target"
                    checked={target?.kind === "new"}
                    onChange={() =>
                        dispatch({ type: "target_chosen", target: { kind: "new" } })
                    }
                    data-testid="assistant-package-target-new"
                />
                {t("assistantPackageImport.targetNew")}
            </label>

            <h3 className="mt-4 text-sm font-semibold">
                {t("assistantPackageImport.targetMerge")}
            </h3>
            {mergeTargets.length === 0 ? (
                <p
                    className="mt-1 text-sm text-zinc-500"
                    data-testid="assistant-package-target-merge-none"
                >
                    {t("assistantPackageImport.targetMergeNone")}
                </p>
            ) : (
                <ul className="mt-1 flex flex-col gap-1">
                    {mergeTargets.map((profile) => (
                        <li key={profile.id}>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="radio"
                                    name="assistant-package-target"
                                    checked={
                                        target?.kind === "merge" &&
                                        target.profileId === profile.id
                                    }
                                    onChange={() =>
                                        dispatch({
                                            type: "target_chosen",
                                            target: {
                                                kind: "merge",
                                                profileId: profile.id,
                                            },
                                        })
                                    }
                                    data-testid={`assistant-package-target-merge-${profile.id}`}
                                />
                                <span className="flex-1">
                                    {profile.icon ? `${profile.icon} ` : ""}
                                    {profile.name}
                                </span>
                                <span className="text-xs text-zinc-500">
                                    {profile.currentRevision === null
                                        ? t(
                                              "assistantPackageImport.targetMergeUnpublished"
                                          )
                                        : interpolate(
                                              t(
                                                  "assistantPackageImport.targetMergeRevision"
                                              ),
                                              { revision: profile.currentRevision }
                                          )}
                                    {" · "}
                                    {interpolate(
                                        t("assistantPackageImport.targetMergeDocuments"),
                                        { count: profile.knowledgeFileCount }
                                    )}
                                </span>
                            </label>
                        </li>
                    ))}
                </ul>
            )}
            {target?.kind === "merge" && (
                <p
                    className="mt-2 text-sm text-amber-700 dark:text-amber-400"
                    data-testid="assistant-package-target-merge-consequence"
                >
                    {t("assistantPackageImport.targetMergeConsequence")}
                </p>
            )}

            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                    {t("assistantPackageImport.uploadBoundaryHeading")}
                </h3>
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                    {/*
                      Two sentences, because the two targets store different
                      things: a create makes a draft assistant that cancelling
                      deletes, a merge stores files against one that already
                      exists and that cancelling must leave alone. One sentence
                      covering both would be wrong about whichever the owner
                      picked.
                    */}
                    {t(
                        target?.kind === "merge"
                            ? "assistantPackageImport.uploadBoundaryBodyMerge"
                            : "assistantPackageImport.uploadBoundaryBody"
                    )}
                </p>
                <label className="mt-2 flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={state.uploadAcknowledged}
                        onChange={() => dispatch({ type: "upload_acknowledged" })}
                        disabled={state.uploadAcknowledged}
                        data-testid="assistant-package-import-upload-ack"
                    />
                    {t("assistantPackageImport.uploadBoundaryAcknowledge")}
                </label>
            </div>
        </section>
    );
}

/**
 * Step 7. Every document, and what the server has managed to do with it.
 *
 * The rows are the browser's list and the statuses are the server's answer,
 * which is why a file that finished uploading still says "reading": the upload
 * is this side's fact and the extraction is the other side's, and collapsing
 * them would let the screen report a document as done before anything had read
 * it.
 */
function UploadStep({
    state,
    onCancel,
    t,
}: {
    state: WizardState;
    onCancel: () => void;
    t: Translate;
}) {
    const failed = state.uploads.filter((upload) => upload.status === "failed");
    return (
        <section className={sectionClass} data-testid="assistant-package-import-upload">
            <h2 className="text-sm font-semibold">
                {t("assistantPackageImport.uploadHeading")}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
                {t("assistantPackageImport.uploadBody")}
            </p>

            {state.uploads.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">
                    {t("assistantPackageImport.uploadNoDocuments")}
                </p>
            ) : (
                <ul className="mt-3 flex flex-col gap-1 text-sm">
                    {state.uploads.map((upload) => (
                        <li
                            key={upload.path}
                            className="flex items-center gap-2"
                            data-testid={`assistant-package-upload-${upload.name}`}
                        >
                            {(upload.status === "uploading" ||
                                upload.status === "processing") && (
                                <Loader2
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                />
                            )}
                            <span className="flex-1">{upload.name}</span>
                            <span
                                className={
                                    upload.status === "failed"
                                        ? "text-red-600"
                                        : "text-zinc-500"
                                }
                            >
                                {t(UPLOAD_STATUS_KEY[upload.status])}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {failed.length > 0 && (
                <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
                    {t("assistantPackageImport.uploadFailedBody")}
                </p>
            )}

            {state.run.kind === "failed" && (
                <p
                    className="mt-3 text-sm text-red-600"
                    data-testid="assistant-package-import-run-failed"
                >
                    {t(runFailureKey(state.run.code))}
                </p>
            )}

            <CancelRun onCancel={onCancel} t={t} />
        </section>
    );
}

/**
 * The way out, from step 7 onward.
 *
 * Present on both steps rather than only on the one that failed: going back is
 * gone once anything is stored, so this is the only control that can undo it,
 * and a control that appears only after something breaks is one nobody knows
 * is there.
 */
function CancelRun({ onCancel, t }: { onCancel: () => void; t: Translate }) {
    return (
        <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <button
                type="button"
                className={secondaryButtonClass}
                onClick={onCancel}
                data-testid="assistant-package-import-cancel"
            >
                {t("assistantPackageImport.runCancel")}
            </button>
            <p className="mt-1 text-xs text-zinc-500">
                {t("assistantPackageImport.runCancelHint")}
            </p>
        </div>
    );
}

/**
 * Step 8. What is about to be published, and the one button that does it.
 *
 * The summary is rendered from the resolved draft rather than from the review,
 * because the owner may have changed any of it -- and because the digest sent
 * with the publish is computed from the same values. A screen that showed the
 * proposal while approving the draft would make the record meaningless.
 */
function ConfirmStep({
    state,
    onPublish,
    onCancel,
    mergeTargets,
    t,
}: {
    state: WizardState;
    onPublish: () => void;
    onCancel: () => void;
    mergeTargets: readonly ImportMergeTarget[];
    t: Translate;
}) {
    const draft = resolveImportDraft(state);
    const kept = state.uploads.filter((upload) => upload.status === "ready");
    const run = state.run;

    if (run.kind === "published") {
        return (
            <section
                className={sectionClass}
                data-testid="assistant-package-import-published"
            >
                <h2 className="text-sm font-semibold">
                    {t(
                        run.unchanged
                            ? "assistantPackageImport.publishedUnchangedHeading"
                            : "assistantPackageImport.publishedHeading"
                    )}
                </h2>
                <p className="mt-1 text-sm">
                    {interpolate(
                        t(
                            run.unchanged
                                ? "assistantPackageImport.publishedUnchangedBody"
                                : "assistantPackageImport.publishedBody"
                        ),
                        { revision: run.revision }
                    )}
                </p>
                <Link
                    href={ASSISTANT_PROFILE_LIST_PATH}
                    className={`mt-3 ${secondaryButtonClass}`}
                    data-testid="assistant-package-import-done"
                >
                    {t("assistantPackageImport.publishedGoToList")}
                </Link>
            </section>
        );
    }

    return (
        <section className={sectionClass} data-testid="assistant-package-import-confirm">
            <h2 className="text-sm font-semibold">
                {t("assistantPackageImport.confirmHeading")}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
                {t("assistantPackageImport.confirmBody")}
            </p>
            <dl className="mt-3 flex flex-col gap-1 text-sm">
                {/*
                  Which assistant this lands on, named before the button that
                  lands it. A merge publishes over something the owner already
                  has, and step 6 may be several minutes behind them by now.
                */}
                <SummaryRow
                    label={t("assistantPackageImport.confirmTarget")}
                    value={confirmTargetValue(state, mergeTargets, t)}
                />
                <SummaryRow label={t("assistantPackageImport.fieldName")} value={draft.name} />
                <SummaryRow
                    label={t("assistantPackageImport.fieldModelIds")}
                    value={draft.modelIds.join(", ")}
                />
                <SummaryRow
                    label={t("assistantPackageImport.confirmDocuments")}
                    value={
                        kept.length === 0
                            ? t("assistantPackageImport.inventoryKnowledgeEmpty")
                            : kept.map((upload) => upload.name).join(", ")
                    }
                />
            </dl>

            {run.kind === "failed" && (
                <p
                    className="mt-3 text-sm text-red-600"
                    data-testid="assistant-package-import-publish-failed"
                >
                    {t(runFailureKey(run.code))}
                </p>
            )}

            <button
                type="button"
                className={`mt-4 ${primaryButtonClass}`}
                disabled={run.kind !== "ready"}
                onClick={onPublish}
                data-testid="assistant-package-import-publish"
            >
                {run.kind === "publishing" && (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                {t("assistantPackageImport.confirmPublish")}
            </button>

            <CancelRun onCancel={onCancel} t={t} />
        </section>
    );
}

/**
 * The target, as a sentence.
 *
 * A merge whose profile is not in the list falls back to naming the merge
 * without the assistant: the list is a snapshot from page load, and a profile
 * deleted in another tab meanwhile would otherwise render as a blank row that
 * reads like "no target". The publish will refuse it either way.
 */
function confirmTargetValue(
    state: WizardState,
    mergeTargets: readonly ImportMergeTarget[],
    t: Translate
): string {
    const target = state.target;
    if (target?.kind !== "merge") return t("assistantPackageImport.targetNew");
    const profile = mergeTargets.find((entry) => entry.id === target.profileId);
    return profile
        ? interpolate(t("assistantPackageImport.confirmTargetMerge"), {
              name: profile.name,
          })
        : t("assistantPackageImport.targetMerge");
}

function SummaryRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex gap-2">
            <dt className="w-40 shrink-0 text-zinc-500">{label}</dt>
            <dd className="flex-1">{value}</dd>
        </div>
    );
}
