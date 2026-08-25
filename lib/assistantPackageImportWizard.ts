/**
 * The import wizard's state machine (Slice 4).
 *
 * docs/policy/assistant-package-import.md §5.
 *
 * The component performs effects; this decides what may happen. The split is
 * the one `lib/externalImportWizard.ts` already uses, and it earns its keep
 * for the same reason: the rules worth getting right here -- which fields may
 * be dropped, when a credential finding stops the import, and above all where
 * the first server write happens -- are then decided by a function a test can
 * call, rather than by whichever button happened to be disabled.
 *
 * ## Steps 1 to 6 write nothing
 *
 * §5.4: the first server row appears at step 7. Cancelling before that has
 * nothing to undo because no request was ever made, and the wizard says so at
 * the 6 -> 7 boundary rather than leaving the owner to guess when their file
 * started being stored. `stepWritesToServer()` is that fact as code, and the
 * boundary acknowledgement is a state transition rather than a rendering
 * detail so it cannot be skipped by a component that forgets it.
 *
 * ## Validation is borrowed, not restated
 *
 * The name, instruction and model limits belong to the profile, not to the
 * import. `profileIdentityProblems()` and `profileVersionProblems()` decide
 * them here too, so a wizard that accepts a draft the editor would reject
 * cannot exist.
 *
 * Pure: no Prisma, no R2, no clock, no network, no React.
 */

import {
    ASSISTANT_PACKAGE_LIMITS,
    type AssistantPackageRefusalCode,
} from "@/lib/assistantPackageLimits";
import type { AssistantPackageReview } from "@/lib/assistantPackageReview";
import {
    findingKey,
    secretOverrideFingerprint,
    type AssistantPackageSecretFinding,
} from "@/lib/assistantPackageSecretScan";
import {
    normalizeProfileIdentity,
    normalizeProfileVersionDraft,
    profileIdentityProblems,
    profileVersionProblems,
    type AssistantMemoryPolicy,
    type AssistantProfileProblem,
    type AssistantToolPolicy,
} from "@/lib/assistantProfileVersioning";

/* ------------------------------------------------------------------ steps */

export const ASSISTANT_PACKAGE_IMPORT_STEPS = [
    /** 1. Choose a local file. No URL box exists, by §1.1. */
    "source",
    /** 2. What the container turned out to be. */
    "detect",
    /** 3. What is inside it, and what about that is worth a warning. */
    "inventory",
    /** 4. Field by field: take it, change it, or leave it out. */
    "fields",
    /** 5. Everything the target cannot hold, stated before anything is kept. */
    "losses",
    /** 6. A new profile, or a merge into one that exists. */
    "target",
    /** 7. Knowledge files are uploaded and processed. First server write. */
    "upload",
    /** 8. Publish, which is when a version row appears. */
    "confirm",
] as const;

export type AssistantPackageImportStep =
    (typeof ASSISTANT_PACKAGE_IMPORT_STEPS)[number];

export const IMPORT_STEP_COUNT = ASSISTANT_PACKAGE_IMPORT_STEPS.length;

/** 1-based, because it is shown to a person. */
export const importStepNumber = (step: AssistantPackageImportStep): number =>
    ASSISTANT_PACKAGE_IMPORT_STEPS.indexOf(step) + 1;

/**
 * The first step that creates anything on the server (§5.4).
 *
 * Named rather than hard-coded at each call site: the whole cancellation
 * contract is "before this, there is nothing to undo", and a second place
 * that decides where "this" is would eventually disagree.
 */
export const FIRST_SERVER_WRITE_STEP: AssistantPackageImportStep = "upload";

export const stepWritesToServer = (step: AssistantPackageImportStep): boolean =>
    importStepNumber(step) >= importStepNumber(FIRST_SERVER_WRITE_STEP);

/* ----------------------------------------------------------------- fields */

export type ImportFieldKey =
    | "name"
    | "icon"
    | "description"
    | "instructions"
    | "starters"
    | "modelIds"
    | "toolPolicy"
    | "memoryPolicy";

/**
 * `use` takes the package's value, `edit` takes the owner's, `exclude` takes
 * neither and leaves the profile's own default.
 */
export type ImportFieldDecision = "use" | "edit" | "exclude";

/**
 * Which fields may be left out.
 *
 * A profile with no name, no instructions or no model is not a profile the
 * editor would accept, so "exclude" is not offered for those three -- an
 * option that always produces an invalid draft is a trap, not a choice.
 * `modelIds` is the one the package never fills: §5.3 keeps entitlement at
 * runtime, so the adapter proposes an empty list and the owner picks.
 */
export const IMPORT_FIELDS: readonly {
    key: ImportFieldKey;
    excludable: boolean;
}[] = [
    { key: "name", excludable: false },
    { key: "icon", excludable: true },
    { key: "description", excludable: true },
    { key: "instructions", excludable: false },
    { key: "starters", excludable: true },
    { key: "modelIds", excludable: false },
    { key: "toolPolicy", excludable: true },
    { key: "memoryPolicy", excludable: true },
];

export const fieldIsExcludable = (key: ImportFieldKey): boolean =>
    IMPORT_FIELDS.find((field) => field.key === key)?.excludable ?? false;

/** What the owner typed, when they chose `edit`. */
export type ImportFieldEdits = {
    name?: string;
    icon?: string | null;
    description?: string | null;
    instructions?: string;
    starters?: string[];
    modelIds?: string[];
    toolPolicy?: AssistantToolPolicy;
    memoryPolicy?: AssistantMemoryPolicy;
};

/* ------------------------------------------------------------------ state */

/**
 * An import the server is still holding, offered on step 1.
 *
 * Shaped for a list rather than for resuming: the wizard reads the import
 * itself when the owner chooses one.
 */
export type ResumableImport = {
    id: string;
    mode: "create" | "merge";
    profileId: string;
    profileName: string;
    published: boolean;
    fileCount: number;
    idleExpiresAt: string;
};

export type ImportTarget =
    | { kind: "new" }
    /**
     * Only the profile's id. The revision to publish from is *not* carried
     * here: the server reads the target's current revision and identity digest
     * when the import is created and checks both again at publish, so a
     * profile edited in another tab meanwhile is a stale publish rather than a
     * silent overwrite. A revision sent by this side would be a second opinion
     * about the same fact, and the one nobody could trust.
     */
    | { kind: "merge"; profileId: string };

/**
 * A profile the owner may merge into.
 *
 * Read on the server when the page loads and handed to the wizard as a prop,
 * so steps 1 to 6 still make no request of their own (§5.4). Everything here
 * is display: what is sent is the id, and every fact the publish depends on is
 * read again by the server.
 */
export type ImportMergeTarget = {
    id: string;
    name: string;
    icon: string | null;
    /** `null` for a profile that has never been published. */
    currentRevision: number | null;
    knowledgeFileCount: number;
};

export type ImportParseState =
    | { kind: "idle" }
    | { kind: "parsing"; entriesRead: number; entriesPlanned: number }
    | { kind: "parsed" }
    | { kind: "refused"; code: AssistantPackageRefusalCode; cause: string };

/** What is known about the chosen file. Never the `File` itself. */
export type ImportFileSummary = { name: string; bytes: number };

/* ------------------------------------------------- steps 7 and 8: the run */

/**
 * One document on its way to the server.
 *
 * `waiting` and `uploading` are the browser's own reading; `processing`,
 * `ready` and `failed` are the server's, read back from the import. The two
 * are separate words on purpose -- a file the browser finished uploading is
 * not a file that has been read, and merging them would let a screen say
 * "done" while extraction was still running.
 */
export type ImportUploadFile = {
    /** The path inside the container, which is the wizard's identity for it. */
    path: string;
    name: string;
    status: "waiting" | "uploading" | "processing" | "ready" | "failed";
    /** The server's file id, once finalize has produced one. */
    fileId: string | null;
    failureCode: string | null;
};

/**
 * Where the run has got to.
 *
 * Distinct from `step`, and both are needed: the step is where the owner is
 * looking, and this is what the server holds. A single field would have to
 * answer "which screen" and "what exists" at once, and the interesting states
 * are exactly the ones where those differ -- a failed publish leaves the owner
 * on step 8 with an import that is still staging.
 */
export type ImportRunState =
    | { kind: "idle" }
    | { kind: "creating" }
    | { kind: "uploading"; importId: string }
    | { kind: "processing"; importId: string }
    /** Every document is `ready`. The only state publishing may start from. */
    | { kind: "ready"; importId: string }
    | { kind: "publishing"; importId: string }
    | {
          kind: "published";
          importId: string;
          revision: number;
          /** The publish found nothing new to record. Not a failure (§5.6). */
          unchanged: boolean;
      }
    /** `importId` is null when the failure happened before one existed. */
    | { kind: "failed"; importId: string | null; code: string };

export type AssistantPackageImportState = {
    step: AssistantPackageImportStep;
    file: ImportFileSummary | null;
    parse: ImportParseState;
    review: AssistantPackageReview | null;
    decisions: Record<ImportFieldKey, ImportFieldDecision>;
    edits: ImportFieldEdits;
    /** Archive paths of the knowledge files the owner is bringing across. */
    knowledgeSelection: readonly string[];
    /** Findings the owner has looked at and decided are not credentials. */
    secretWaivers: readonly AssistantPackageSecretFinding[];
    lossesAcknowledged: boolean;
    target: ImportTarget | null;
    /** The 6 -> 7 boundary: uploading was explicitly agreed to. */
    uploadAcknowledged: boolean;
    /** What the server holds, from step 7 onward. */
    run: ImportRunState;
    /** One row per document being brought across, in selection order. */
    uploads: readonly ImportUploadFile[];
};

const defaultDecisions = (): Record<ImportFieldKey, ImportFieldDecision> => ({
    name: "use",
    icon: "use",
    description: "use",
    instructions: "use",
    starters: "use",
    // Nothing was proposed, so there is nothing to "use". The owner picks, and
    // starting at `edit` says that rather than showing an empty accepted value.
    modelIds: "edit",
    toolPolicy: "use",
    memoryPolicy: "use",
});

export const initialImportState = (): AssistantPackageImportState => ({
    step: "source",
    file: null,
    parse: { kind: "idle" },
    review: null,
    decisions: defaultDecisions(),
    edits: {},
    knowledgeSelection: [],
    secretWaivers: [],
    lossesAcknowledged: false,
    target: null,
    uploadAcknowledged: false,
    run: { kind: "idle" },
    uploads: [],
});

/**
 * The draft inside a stored `stagingManifest`, or null if it is not there.
 *
 * The manifest is this app's own JSON, but it was written by whatever version
 * of the wizard created the import -- possibly one that is no longer deployed.
 * So it is checked rather than trusted, and a manifest that does not carry a
 * complete draft means the import cannot be resumed. That is a thing to say on
 * screen, not a set of empty fields to publish.
 */
export function resumableDraftFromManifest(
    manifest: unknown
): ProfileDraftFromImport | null {
    if (typeof manifest !== "object" || manifest === null) return null;
    const draft = (manifest as { draft?: unknown }).draft;
    if (typeof draft !== "object" || draft === null) return null;
    const value = draft as Record<string, unknown>;

    const text = (key: string): string | null =>
        typeof value[key] === "string" ? (value[key] as string) : null;
    const nullableText = (key: string): string | null | undefined =>
        value[key] === null
            ? null
            : typeof value[key] === "string"
              ? (value[key] as string)
              : undefined;
    const strings = (key: string): string[] | null =>
        Array.isArray(value[key]) &&
        (value[key] as unknown[]).every((entry) => typeof entry === "string")
            ? ([...(value[key] as string[])] as string[])
            : null;
    const flag = (holder: unknown, key: string): boolean | null => {
        if (typeof holder !== "object" || holder === null) return null;
        const found = (holder as Record<string, unknown>)[key];
        return typeof found === "boolean" ? found : null;
    };

    const name = text("name");
    const instructions = text("instructions");
    const icon = nullableText("icon");
    const description = nullableText("description");
    const starters = strings("starters");
    const modelIds = strings("modelIds");
    const webSearch = flag(value.toolPolicy, "webSearch");
    const deepResearch = flag(value.toolPolicy, "deepResearch");
    const useAccountMemory = flag(value.memoryPolicy, "useAccountMemory");

    if (
        name === null ||
        instructions === null ||
        icon === undefined ||
        description === undefined ||
        starters === null ||
        modelIds === null ||
        webSearch === null ||
        deepResearch === null ||
        useAccountMemory === null
    ) {
        return null;
    }

    return {
        name,
        icon,
        description,
        instructions,
        starters,
        modelIds,
        toolPolicy: { webSearch, deepResearch },
        memoryPolicy: { useAccountMemory },
    };
}

/* ---------------------------------------------------------------- actions */

export type AssistantPackageImportAction =
    | { type: "file_selected"; file: ImportFileSummary }
    | { type: "parse_progress"; entriesRead: number; entriesPlanned: number }
    | { type: "parse_succeeded"; review: AssistantPackageReview }
    | {
          type: "parse_refused";
          code: AssistantPackageRefusalCode;
          cause: string;
      }
    | { type: "field_decided"; field: ImportFieldKey; decision: ImportFieldDecision }
    | { type: "field_edited"; edits: ImportFieldEdits }
    | { type: "knowledge_toggled"; path: string }
    | { type: "secret_waived"; finding: AssistantPackageSecretFinding }
    | { type: "secret_unwaived"; finding: AssistantPackageSecretFinding }
    | { type: "losses_acknowledged"; acknowledged: boolean }
    | { type: "target_chosen"; target: ImportTarget }
    | { type: "upload_acknowledged" }
    | { type: "run_started" }
    | { type: "import_created"; importId: string; uploads: ImportUploadFile[] }
    | {
          type: "upload_progressed";
          path: string;
          status: ImportUploadFile["status"];
          fileId?: string | null;
          failureCode?: string | null;
      }
    /** The server's own reading of every staged file, from the import. */
    | {
          type: "processing_observed";
          files: readonly {
              id: string;
              processingStatus: string;
              failureCode: string | null;
          }[];
      }
    | { type: "publish_started" }
    | { type: "publish_succeeded"; revision: number; unchanged: boolean }
    | { type: "run_failed"; code: string }
    | { type: "advanced" }
    | { type: "went_back" }
    | {
          /**
           * Picking up an import the server already holds.
           *
           * Every field decision becomes `edit` and every edit is filled from
           * the manifest the server stored, so `resolveImportDraft()` returns
           * exactly what was staged. It has to: the container is gone, so
           * there is no review to propose from, and a `use` decision would
           * resolve against a review that is null.
           */
          type: "resumed";
          importId: string;
          target: ImportTarget;
          draft: ProfileDraftFromImport;
          uploads: ImportUploadFile[];
      }
    | { type: "restarted" };

const stepAfter = (
    step: AssistantPackageImportStep
): AssistantPackageImportStep =>
    ASSISTANT_PACKAGE_IMPORT_STEPS[
        Math.min(importStepNumber(step), IMPORT_STEP_COUNT - 1)
    ];

const stepBefore = (
    step: AssistantPackageImportStep
): AssistantPackageImportStep =>
    ASSISTANT_PACKAGE_IMPORT_STEPS[Math.max(importStepNumber(step) - 2, 0)];

/**
 * Going back is allowed while nothing has been written, and not after.
 *
 * §5.6 gives step 7 onward its own cancellation contract precisely because
 * there is state to release; a plain "back" there would leave a staged upload
 * with nothing pointing at it.
 */
export const canGoBack = (state: AssistantPackageImportState): boolean =>
    state.step !== "source" && !stepWritesToServer(state.step);

export function assistantPackageImportReducer(
    state: AssistantPackageImportState,
    action: AssistantPackageImportAction
): AssistantPackageImportState {
    switch (action.type) {
        case "file_selected":
            // A new file is a new import. Keeping the old review's decisions
            // would silently apply one package's choices to another's fields.
            return {
                ...initialImportState(),
                file: action.file,
                parse: { kind: "parsing", entriesRead: 0, entriesPlanned: 0 },
            };
        case "parse_progress":
            return state.parse.kind === "parsing"
                ? {
                      ...state,
                      parse: {
                          kind: "parsing",
                          entriesRead: action.entriesRead,
                          entriesPlanned: action.entriesPlanned,
                      },
                  }
                : state;
        case "parse_succeeded":
            return {
                ...state,
                parse: { kind: "parsed" },
                review: action.review,
                step: "detect",
                // Every candidate starts selected: the package's author put
                // them there, and an owner who wants fewer removes them. The
                // cap is enforced by the parser, so this cannot start over it.
                knowledgeSelection: action.review.knowledgeCandidates.map(
                    (candidate) => candidate.path
                ),
            };
        case "parse_refused":
            return {
                ...state,
                parse: { kind: "refused", code: action.code, cause: action.cause },
                review: null,
                step: "detect",
            };
        case "field_decided":
            if (action.decision === "exclude" && !fieldIsExcludable(action.field)) {
                return state;
            }
            return {
                ...state,
                decisions: { ...state.decisions, [action.field]: action.decision },
            };
        case "field_edited":
            return { ...state, edits: { ...state.edits, ...action.edits } };
        case "knowledge_toggled": {
            const selected = state.knowledgeSelection.includes(action.path);
            if (
                !selected &&
                state.knowledgeSelection.length >=
                    ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles
            ) {
                // Refuse the addition without disturbing what is already
                // chosen, and never by silently dropping someone else's file.
                return state;
            }
            return {
                ...state,
                knowledgeSelection: selected
                    ? state.knowledgeSelection.filter((path) => path !== action.path)
                    : [...state.knowledgeSelection, action.path],
            };
        }
        case "secret_waived": {
            const key = findingKey(action.finding);
            return state.secretWaivers.some(
                (waiver) => findingKey(waiver) === key
            )
                ? state
                : { ...state, secretWaivers: [...state.secretWaivers, action.finding] };
        }
        case "secret_unwaived": {
            const key = findingKey(action.finding);
            return {
                ...state,
                secretWaivers: state.secretWaivers.filter(
                    (waiver) => findingKey(waiver) !== key
                ),
            };
        }
        case "losses_acknowledged":
            return { ...state, lossesAcknowledged: action.acknowledged };
        case "target_chosen": {
            // Changing the target un-ticks the boundary acknowledgement. The
            // sentence beside that box is not the same sentence for the two
            // targets -- a create stores a draft assistant, a merge stores
            // files against one that already exists -- so an acknowledgement
            // carried across would be the owner having agreed to the other one.
            const same =
                state.target !== null &&
                state.target.kind === action.target.kind &&
                (action.target.kind !== "merge" ||
                    (state.target.kind === "merge" &&
                        state.target.profileId === action.target.profileId));
            return {
                ...state,
                target: action.target,
                uploadAcknowledged: same ? state.uploadAcknowledged : false,
            };
        }
        case "upload_acknowledged":
            return { ...state, uploadAcknowledged: true };
        case "run_started":
            return { ...state, run: { kind: "creating" } };
        case "import_created":
            return {
                ...state,
                run: { kind: "uploading", importId: action.importId },
                uploads: action.uploads,
            };
        case "upload_progressed":
            return {
                ...state,
                uploads: state.uploads.map((upload) =>
                    upload.path === action.path
                        ? {
                              ...upload,
                              status: action.status,
                              fileId:
                                  action.fileId === undefined
                                      ? upload.fileId
                                      : action.fileId,
                              failureCode:
                                  action.failureCode === undefined
                                      ? upload.failureCode
                                      : action.failureCode,
                          }
                        : upload
                ),
            };
        case "processing_observed": {
            const byId = new Map(action.files.map((file) => [file.id, file]));
            const uploads = state.uploads.map((upload) => {
                const observed = upload.fileId ? byId.get(upload.fileId) : undefined;
                if (!observed) return upload;
                // The server's word replaces the browser's guess, and only for
                // the three states the server owns. A row still uploading has
                // no id yet, so it cannot be overwritten from here.
                const status: ImportUploadFile["status"] =
                    observed.processingStatus === "ready"
                        ? "ready"
                        : observed.processingStatus === "failed"
                          ? "failed"
                          : "processing";
                return { ...upload, status, failureCode: observed.failureCode };
            });
            const importId =
                state.run.kind === "uploading" ||
                state.run.kind === "processing" ||
                state.run.kind === "ready"
                    ? state.run.importId
                    : null;
            if (importId === null) return { ...state, uploads };
            const everyReady =
                uploads.length > 0 &&
                uploads.every((upload) => upload.status === "ready");
            const emptyRun = uploads.length === 0;
            return {
                ...state,
                uploads,
                run:
                    everyReady || emptyRun
                        ? { kind: "ready", importId }
                        : { kind: "processing", importId },
            };
        }
        case "publish_started":
            return state.run.kind === "ready"
                ? { ...state, run: { kind: "publishing", importId: state.run.importId } }
                : state;
        case "publish_succeeded":
            return state.run.kind === "publishing"
                ? {
                      ...state,
                      run: {
                          kind: "published",
                          importId: state.run.importId,
                          revision: action.revision,
                          unchanged: action.unchanged,
                      },
                  }
                : state;
        case "run_failed":
            return {
                ...state,
                run: {
                    kind: "failed",
                    importId:
                        "importId" in state.run ? (state.run.importId as string) : null,
                    code: action.code,
                },
            };
        case "advanced":
            return advanceProblems(state).length === 0
                ? { ...state, step: stepAfter(state.step) }
                : state;
        case "went_back":
            return canGoBack(state)
                ? { ...state, step: stepBefore(state.step) }
                : state;
        case "resumed": {
            const ready = action.uploads.every(
                (upload) => upload.status === "ready"
            );
            return {
                ...initialImportState(),
                // Step 8 only when every document is ready, because that is
                // the only state publishing may start from. Otherwise step 7,
                // where the owner watches the rest finish -- which is also
                // where the cancel control lives.
                step: ready ? "confirm" : "upload",
                decisions: {
                    name: "edit",
                    icon: "edit",
                    description: "edit",
                    instructions: "edit",
                    starters: "edit",
                    modelIds: "edit",
                    toolPolicy: "edit",
                    memoryPolicy: "edit",
                },
                edits: {
                    name: action.draft.name,
                    icon: action.draft.icon,
                    description: action.draft.description,
                    instructions: action.draft.instructions,
                    starters: [...action.draft.starters],
                    modelIds: [...action.draft.modelIds],
                    toolPolicy: action.draft.toolPolicy,
                    memoryPolicy: action.draft.memoryPolicy,
                },
                target: action.target,
                // Both were agreed to before the import was created: the
                // server would not be holding it otherwise. Asking again on
                // resume would be asking about a boundary already crossed.
                lossesAcknowledged: true,
                uploadAcknowledged: true,
                run: ready
                    ? { kind: "ready", importId: action.importId }
                    : { kind: "processing", importId: action.importId },
                uploads: action.uploads,
            };
        }
        case "restarted":
            return initialImportState();
        default:
            return state;
    }
}

/* ------------------------------------------------------------- selectors */

/** Findings the owner has not decided about. Each one stops the import (A5). */
export function unwaivedFindings(
    state: AssistantPackageImportState
): AssistantPackageSecretFinding[] {
    const waived = new Set(state.secretWaivers.map(findingKey));
    return (state.review?.secretFindings ?? []).filter(
        (finding) => !waived.has(findingKey(finding))
    );
}

export type ProfileDraftFromImport = {
    name: string;
    icon: string | null;
    description: string | null;
    instructions: string;
    starters: string[];
    modelIds: string[];
    toolPolicy: AssistantToolPolicy;
    memoryPolicy: AssistantMemoryPolicy;
};

const DEFAULT_TOOL_POLICY: AssistantToolPolicy = {
    webSearch: false,
    deepResearch: false,
};
const DEFAULT_MEMORY_POLICY: AssistantMemoryPolicy = { useAccountMemory: false };

/**
 * The draft the three decisions produce.
 *
 * `exclude` yields the profile's own default rather than the package's value,
 * which for every excludable field here means absent or off. That is the whole
 * meaning of leaving something out, and writing it once keeps a screen from
 * inventing a fourth interpretation.
 */
export function resolveImportDraft(
    state: AssistantPackageImportState
): ProfileDraftFromImport {
    const review = state.review;
    const pick = <T,>(
        key: ImportFieldKey,
        proposed: T,
        edited: T | undefined,
        excluded: T
    ): T => {
        const decision = state.decisions[key];
        if (decision === "exclude") return excluded;
        if (decision === "edit") return edited === undefined ? proposed : edited;
        return proposed;
    };

    return {
        name: pick("name", review?.identity.name.value ?? "", state.edits.name, ""),
        icon: pick("icon", review?.identity.icon.value ?? null, state.edits.icon, null),
        description: pick(
            "description",
            review?.identity.description.value ?? null,
            state.edits.description,
            null
        ),
        instructions: pick(
            "instructions",
            review?.instructions.value ?? "",
            state.edits.instructions,
            ""
        ),
        starters: pick(
            "starters",
            [...(review?.starters.value ?? [])],
            state.edits.starters,
            []
        ),
        modelIds: pick(
            "modelIds",
            [...(review?.modelIds.value ?? [])],
            state.edits.modelIds,
            []
        ),
        toolPolicy: pick(
            "toolPolicy",
            review?.toolPolicy.value ?? DEFAULT_TOOL_POLICY,
            state.edits.toolPolicy,
            DEFAULT_TOOL_POLICY
        ),
        memoryPolicy: pick(
            "memoryPolicy",
            review?.memoryPolicy.value ?? DEFAULT_MEMORY_POLICY,
            state.edits.memoryPolicy,
            DEFAULT_MEMORY_POLICY
        ),
    };
}

/**
 * Why the current step cannot be left.
 *
 * `field` names a profile field when the profile's own validator produced the
 * problem, so a screen can put the message next to the input rather than at
 * the bottom of the page.
 */
export type ImportBlock =
    | { kind: "no_file" }
    | { kind: "parsing" }
    | { kind: "package_refused" }
    | { kind: "unwaived_secret"; count: number }
    | { kind: "invalid_draft"; problem: AssistantProfileProblem }
    | { kind: "too_many_knowledge_files"; limit: number }
    | { kind: "losses_unacknowledged" }
    | { kind: "no_target" }
    | { kind: "upload_unacknowledged" }
    | { kind: "run_failed"; code: string }
    | { kind: "documents_pending"; pending: number }
    | { kind: "documents_failed"; failed: number };

export function advanceProblems(
    state: AssistantPackageImportState
): ImportBlock[] {
    const blocks: ImportBlock[] = [];
    switch (state.step) {
        case "source":
            if (!state.file) blocks.push({ kind: "no_file" });
            else if (state.parse.kind === "parsing") blocks.push({ kind: "parsing" });
            else if (state.parse.kind !== "parsed") {
                blocks.push({ kind: "package_refused" });
            }
            break;
        case "detect":
            if (state.parse.kind !== "parsed" || !state.review) {
                blocks.push({ kind: "package_refused" });
            }
            break;
        case "inventory": {
            const unwaived = unwaivedFindings(state);
            if (unwaived.length > 0) {
                blocks.push({ kind: "unwaived_secret", count: unwaived.length });
            }
            if (
                state.knowledgeSelection.length >
                ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles
            ) {
                blocks.push({
                    kind: "too_many_knowledge_files",
                    limit: ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles,
                });
            }
            break;
        }
        case "fields": {
            const draft = resolveImportDraft(state);
            // Normalised first, because the validators judge the stored value
            // rather than the typed one: a name of three spaces is empty by
            // the time it reaches the column, and a wizard that accepts it
            // sends the owner forward to be rejected at publish.
            for (const problem of profileIdentityProblems(
                normalizeProfileIdentity({
                    name: draft.name,
                    icon: draft.icon,
                    description: draft.description,
                })
            )) {
                blocks.push({ kind: "invalid_draft", problem });
            }
            for (const problem of profileVersionProblems(
                normalizeProfileVersionDraft({
                    instructions: draft.instructions,
                    modelIds: draft.modelIds,
                    toolPolicy: draft.toolPolicy,
                    memoryPolicy: draft.memoryPolicy,
                    starters: draft.starters,
                    knowledgeManifest: [],
                })
            )) {
                blocks.push({ kind: "invalid_draft", problem });
            }
            break;
        }
        case "losses":
            if ((state.review?.losses.length ?? 0) > 0 && !state.lossesAcknowledged) {
                blocks.push({ kind: "losses_unacknowledged" });
            }
            break;
        case "target":
            if (!state.target) blocks.push({ kind: "no_target" });
            if (!state.uploadAcknowledged) {
                blocks.push({ kind: "upload_unacknowledged" });
            }
            break;
        case "upload": {
            if (state.run.kind === "failed") {
                blocks.push({ kind: "run_failed", code: state.run.code });
                break;
            }
            const failed = state.uploads.filter(
                (upload) => upload.status === "failed"
            ).length;
            if (failed > 0) {
                // Not "carry on without it". A document that could not be read
                // is the owner's choice to remove or replace, and a publish
                // that quietly dropped it is the failure the loss report
                // exists to prevent -- except invisible.
                blocks.push({ kind: "documents_failed", failed });
            }
            const pending = state.uploads.filter(
                (upload) => upload.status !== "ready" && upload.status !== "failed"
            ).length;
            if (pending > 0) blocks.push({ kind: "documents_pending", pending });
            // An import with no documents has nothing to wait for, so nothing
            // blocks it: the poll moves it on by itself, and a "still reading"
            // line while there is nothing to read would be a sentence about
            // documents that do not exist.
            break;
        }
        case "confirm":
            // Step 8 has no next: publishing is its own action with its own
            // outcome, and an "advance" that published would be a second way
            // to trigger the one thing on this screen that cannot be undone.
            break;
    }
    return blocks;
}

export const canAdvance = (state: AssistantPackageImportState): boolean =>
    advanceProblems(state).length === 0;

/* --------------------------------------------------- what gets published */

/** The version of the approval payload's shape, stored beside the digest. */
export const IMPORT_APPROVAL_DIGEST_VERSION = 1;

/** The server file ids to keep. Anything staged and not listed is discarded. */
export const keepFileIds = (state: AssistantPackageImportState): string[] =>
    state.uploads
        .filter((upload) => upload.status === "ready" && upload.fileId !== null)
        .map((upload) => upload.fileId as string);

/**
 * Exactly what the confirmation screen showed, as one string.
 *
 * Its digest is the only thing that can prove afterwards that what was stored
 * is what a person looked at and agreed to. So it carries the fields, the
 * documents *and* the credential findings that were waived: a payload that
 * omitted the waivers would let an approval be replayed against a package
 * whose secrets nobody had decided about.
 *
 * Built from the resolved draft rather than from the review, because the
 * owner may have changed any of it -- the review is the proposal and this is
 * the answer.
 */
export function importApprovalPayload(
    state: AssistantPackageImportState
): string {
    const draft = resolveImportDraft(state);
    const documents = state.uploads
        .filter((upload) => upload.status === "ready")
        .map((upload) => upload.name)
        .sort();
    return [
        `digestVersion=${IMPORT_APPROVAL_DIGEST_VERSION}`,
        `mode=${state.target?.kind ?? "none"}`,
        `name=${draft.name}`,
        `icon=${draft.icon ?? ""}`,
        `description=${draft.description ?? ""}`,
        `instructions=${draft.instructions}`,
        `modelIds=${draft.modelIds.join(",")}`,
        `starters=${JSON.stringify(draft.starters)}`,
        `webSearch=${draft.toolPolicy.webSearch}`,
        `deepResearch=${draft.toolPolicy.deepResearch}`,
        `useAccountMemory=${draft.memoryPolicy.useAccountMemory}`,
        `documents=${JSON.stringify(documents)}`,
        `waivedSecrets=${secretOverrideFingerprint(state.secretWaivers)}`,
    ].join("\n");
}
