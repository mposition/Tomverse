"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Loader2, Upload } from "lucide-react";

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
    type AssistantPackageRefusalCode,
    type AssistantPackageSkipReason,
} from "@/lib/assistantPackageLimits";
import {
    ASSISTANT_PACKAGE_IMPORT_STEPS,
    IMPORT_FIELDS,
    IMPORT_STEP_COUNT,
    advanceProblems,
    assistantPackageImportReducer,
    canAdvance,
    canGoBack,
    importStepNumber,
    initialImportState,
    resolveImportDraft,
    stepWritesToServer,
    unwaivedFindings,
    type AssistantPackageImportStep,
    type ImportBlock,
    type ImportFieldKey,
} from "@/lib/assistantPackageImportWizard";
import { findingKey } from "@/lib/assistantPackageSecretScan";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { assistantProfileHierarchy } from "@/lib/settingsNavigation";
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
 *     make no request at all (§5.2), which is why there is no loading state
 *     here that is not the worker;
 *   * the 6 -> 7 boundary is stated before it is crossed. The owner ticks a
 *     box that says files start being stored, and `uploadAcknowledged` is
 *     state rather than a rendering detail so a redesign cannot lose it.
 *
 * Step 7 (upload) and step 8 (publish) need server endpoints that do not exist
 * yet. The state machine already knows those steps; this component stops at
 * the boundary, and the route stays behind a flag that is off.
 *
 * The step bodies are local components rather than files of their own. Each is
 * short because the decisions are elsewhere -- unlike the external import's
 * steps, which carry a virtualized list and a provider guide -- and splitting
 * six thirty-line renderers across six files would spread one screen over
 * seven of them.
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

export function AssistantPackageImportWizard({
    onBeginUpload,
}: {
    /**
     * What crossing the 6 -> 7 boundary does.
     *
     * A port rather than a call, because crossing it uploads files and this
     * component has nothing to upload with until the endpoints exist. Absent,
     * the wizard stops at step 6 and says so, which is the honest rendering:
     * a wizard that walked into step 7 with no way forward and no way back
     * would be a dead end wearing a progress indicator.
     */
    onBeginUpload?: () => void;
} = {}) {
    const { t } = useLanguage();
    const [state, dispatch] = useReducer(
        assistantPackageImportReducer,
        undefined,
        initialImportState
    );
    const workerRef = useRef<Worker | null>(null);

    useEffect(
        () => () => {
            workerRef.current?.terminate();
            workerRef.current = null;
        },
        []
    );

    const openPackage = useCallback((file: File) => {
        workerRef.current?.terminate();
        const worker = new Worker(
            new URL("../../../lib/workers/assistantPackageWorker.ts", import.meta.url),
            { type: "module" }
        );
        workerRef.current = worker;
        dispatch({ type: "file_selected", file: { name: file.name, bytes: file.size } });

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const message = event.data;
            if (message.type === "progress") {
                dispatch({
                    type: "parse_progress",
                    entriesRead: message.entriesRead,
                    entriesPlanned: message.entriesPlanned,
                });
                return;
            }
            if (message.type === "review") {
                dispatch({ type: "parse_succeeded", review: message.review });
            } else if (message.type === "refused") {
                dispatch({
                    type: "parse_refused",
                    code: message.code,
                    cause: message.cause,
                });
            }
            worker.terminate();
            workerRef.current = null;
        };
        worker.onerror = () => {
            // The worker failing is this app failing, not a statement about
            // the package -- and the error object can carry a file path, so
            // none of it is shown or kept.
            dispatch({
                type: "parse_refused",
                code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
                cause: "parser_error",
            });
            worker.terminate();
            workerRef.current = null;
        };

        const request: WorkerRequest = { type: "parse", file };
        worker.postMessage(request);
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
                    <SourceStep state={state} onFile={openPackage} t={t} />
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
                        uploadAvailable={Boolean(onBeginUpload)}
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
                    // The boundary is the only place the port matters: every
                    // other step is decided entirely in the browser.
                    disabled={
                        !canAdvance(state) ||
                        stepWritesToServer(state.step) ||
                        (state.step === "target" && !onBeginUpload)
                    }
                    onClick={() => {
                        if (state.step === "target") {
                            onBeginUpload?.();
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
type WizardState = ReturnType<typeof initialImportState>;
type Dispatch = (action: Parameters<typeof assistantPackageImportReducer>[1]) => void;

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
        return (
            <ModelSelector
                label={t("assistantPackageImport.fieldModelIds")}
                hint={t("assistantPackageImport.fieldModelIdsHint")}
                selected={draft.modelIds}
                onChange={(next) =>
                    dispatch({ type: "field_edited", edits: { modelIds: next } })
                }
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
                                        {loss.items.join(", ")}
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

function TargetStep({
    state,
    dispatch,
    uploadAvailable,
    t,
}: {
    state: WizardState;
    dispatch: Dispatch;
    uploadAvailable: boolean;
    t: Translate;
}) {
    return (
        <section className={sectionClass} data-testid="assistant-package-import-target">
            <h2 className="text-sm font-semibold">
                {t("assistantPackageImport.targetHeading")}
            </h2>
            <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                    type="radio"
                    name="assistant-package-target"
                    checked={state.target?.kind === "new"}
                    onChange={() =>
                        dispatch({ type: "target_chosen", target: { kind: "new" } })
                    }
                    data-testid="assistant-package-target-new"
                />
                {t("assistantPackageImport.targetNew")}
            </label>
            {/*
              Merging into an existing profile needs that profile's current
              revision, which comes from the list endpoint the upload step
              uses. Until that step exists there is nothing to merge into that
              this screen could name honestly.
            */}
            <p className="mt-2 text-xs text-zinc-500">
                {t("assistantPackageImport.targetMergeLater")}
            </p>

            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                    {t("assistantPackageImport.uploadBoundaryHeading")}
                </h3>
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                    {t("assistantPackageImport.uploadBoundaryBody")}
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
                {!uploadAvailable && (
                    <p
                        className="mt-2 text-sm"
                        data-testid="assistant-package-import-upload-unavailable"
                    >
                        {t("assistantPackageImport.uploadNotConfigured")}
                    </p>
                )}
            </div>
        </section>
    );
}
