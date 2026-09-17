/**
 * Pure, provider-free admission-readiness verifier.
 *
 * It validates checked-in synthetic shadow evidence and emits a proposal. It
 * does not approve a stage, reserve money, mutate authority state, or admit an
 * execution.
 */
import { createHash } from "node:crypto";

import {
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
    PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
} from "./promptRefinerExecutionContract";
import {
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
    PROMPT_REFINER_RESERVATION_TTL_MS,
} from "./promptRefinerReservationCore";
import {
    PROMPT_REFINER_SHADOW_CORPUS_CASES,
    PROMPT_REFINER_SHADOW_HARNESS_VERSION,
    parsePromptRefinerShadowCorpus,
} from "./promptRefinerShadowHarness";
import {
    PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES,
    PROMPT_REFINER_SHADOW_JOURNAL_VERSION,
    replayPromptRefinerShadowJournal,
} from "./promptRefinerShadowJournal";
import {
    PROMPT_REFINER_SHADOW_CORPUS_PATH,
    PROMPT_REFINER_SHADOW_SOURCE_PATHS,
    promptRefinerShadowSourceIdentityDigest,
} from "./promptRefinerShadowSource";
import {
    canonicalBenchmarkJson,
    parseBenchmarkJson,
    strictBenchmarkObject,
} from "./routerDevelopmentBenchmark";

// Security boundary: these primordials are captured at module initialization.
// Runtime callers may supply hostile evidence and may later replace ambient
// globals, but application bootstrap must load this module before modifying
// JavaScript intrinsics. Imported strict parsers share that bootstrap boundary.
const INTRINSIC_OBJECT_FREEZE = Object.freeze;
const INTRINSIC_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const INTRINSIC_REFLECT_APPLY = Reflect.apply;
const INTRINSIC_ARRAY_IS_ARRAY = Array.isArray;
const INTRINSIC_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
// RegExp.prototype.test dynamically dispatches through the receiver's current
// exec property. Capture the native exec implementation itself so a caller
// cannot replace either ambient method after this module has initialized.
const INTRINSIC_REGEXP_EXEC = RegExp.prototype.exec;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const INTRINSIC_UINT8_ARRAY_SET = Uint8Array.prototype.set;
const INTRINSIC_TEXT_DECODER = TextDecoder;
const INTRINSIC_TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const RAW_TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE,
    "byteLength"
)?.get;
const RAW_TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE,
    Symbol.toStringTag
)?.get;
const HASH_PROTOTYPE = Object.getPrototypeOf(createHash("sha256"));
const INTRINSIC_HASH_UPDATE = HASH_PROTOTYPE.update;
const INTRINSIC_HASH_DIGEST = HASH_PROTOTYPE.digest;
const FULL_SHA_PATTERN = /^[a-f0-9]{40}$/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PREFIXED_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

if (
    typeof RAW_TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function" ||
    typeof RAW_TYPED_ARRAY_TAG_GETTER !== "function" ||
    typeof INTRINSIC_HASH_UPDATE !== "function" ||
    typeof INTRINSIC_HASH_DIGEST !== "function"
) {
    throw new Error("prompt_refiner_shadow_admission_intrinsic_unavailable");
}
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
    RAW_TYPED_ARRAY_BYTE_LENGTH_GETTER as () => number;
const TYPED_ARRAY_TAG_GETTER = RAW_TYPED_ARRAY_TAG_GETTER as () => string;

export const PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_VERSION =
    "prompt-refiner-shadow-admission-evidence-v1" as const;
export const PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION =
    "prompt-refiner-shadow-stage-proposal-v1" as const;
export const PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF =
    "f1e1b0c23fd93cfa9dbaa0a68abe603d989c3830" as const;
export const PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST =
    "ac1813483dc62e44bb34fdc681be908611d72493567ba437322012a6e3438f39" as const;
export const PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST =
    "bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958" as const;
export const PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST =
    "sha256:61d66909a0d493c9b0bfae5faaa3e79ad827a6cba8598f39167ecf506176a159" as const;
export const PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256 =
    "9e15f6413083dd980fbd9003d9396d2c8519cacedba20fcb4bb951a796a7b73d" as const;
export const PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST =
    "sha256:75198565b0bcc1e481c89c6ac8946d11793d28b7afbd96e18d36a03a27f06cc2" as const;

const INTERNAL_ADMISSION_EVIDENCE_FILES = INTRINSIC_OBJECT_FREEZE([
    "admission-readiness-v1.report.json",
    "admission-readiness-v1.journal.jsonl",
    "admission-readiness-v1.journal.jsonl.witness.jsonl",
] as const);

export const PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_FILES =
    INTRINSIC_OBJECT_FREEZE([
        INTERNAL_ADMISSION_EVIDENCE_FILES[0],
        INTERNAL_ADMISSION_EVIDENCE_FILES[1],
        INTERNAL_ADMISSION_EVIDENCE_FILES[2],
    ] as const);

const INTERNAL_STAGE_ACKNOWLEDGEMENTS = INTRINSIC_OBJECT_FREEZE([
    "synthetic_structural_prerequisite_only",
    "not_model_quality_evidence",
    "not_paid_shadow_approval",
    "not_planner_approval",
    "not_release_approval",
    "not_rollout_approval",
    "historical_evidence_snapshot_only",
    "current_checkout_not_validated",
    "runtime_source_revalidation_required",
] as const);

export const PROMPT_REFINER_SHADOW_STAGE_ACKNOWLEDGEMENTS =
    INTRINSIC_OBJECT_FREEZE([
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[0],
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[1],
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[2],
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[3],
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[4],
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[5],
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[6],
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[7],
        INTERNAL_STAGE_ACKNOWLEDGEMENTS[8],
    ] as const);

const MANIFEST_MAX_BYTES = 64 * 1024;
const REPORT_MAX_BYTES = 64 * 1024;
const CORPUS_MAX_BYTES = 1024 * 1024;
type EvidenceBytes = Uint8Array;

declare const preboundedEvidenceInput: unique symbol;

export type PromptRefinerShadowAdmissionEvidenceInput = {
    manifestBytes: EvidenceBytes;
    reportBytes: EvidenceBytes;
    journalBytes: EvidenceBytes;
    witnessBytes: EvidenceBytes;
    corpusBytes: EvidenceBytes;
};

type PreboundedAdmissionEvidenceInput =
    PromptRefinerShadowAdmissionEvidenceInput & {
        readonly [preboundedEvidenceInput]: true;
    };

type EvidenceFile = {
    name: (typeof PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_FILES)[number];
    sizeBytes: number;
    sha256: string;
};

type TerminalHead = {
    seq: number;
    entryDigest: string;
};

type AdmissionEvidenceManifest = {
    schemaVersion: typeof PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_VERSION;
    harnessVersion: typeof PROMPT_REFINER_SHADOW_HARNESS_VERSION;
    journalSchemaVersion: typeof PROMPT_REFINER_SHADOW_JOURNAL_VERSION;
    sourceRef: typeof PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF;
    sourceIdentityDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST;
    corpusDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST;
    files: EvidenceFile[];
    journalTerminal: TerminalHead;
    witnessTerminal: TerminalHead;
    bundleDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST;
};

export type PromptRefinerShadowStageProposal = {
    readonly schemaVersion: typeof PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION;
    readonly status: "awaiting_explicit_admin_cost_approval";
    readonly executionAdmitted: false;
    readonly currentCheckoutValidated: false;
    readonly runtimeSourceRevalidationRequired: true;
    readonly evidenceBundleDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST;
    readonly proposalDigest: typeof PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST;
    readonly provenance: Readonly<{
        sourceRef: typeof PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF;
        sourceIdentityDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST;
        corpusDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST;
        harnessVersion: typeof PROMPT_REFINER_SHADOW_HARNESS_VERSION;
        journalSchemaVersion: typeof PROMPT_REFINER_SHADOW_JOURNAL_VERSION;
    }>;
    readonly reservationStage: Readonly<{
        stageId: typeof PROMPT_REFINER_RESERVATION_STAGE_ID;
        contractDigest: typeof PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST;
        perRequestCostMicroUsd: typeof PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD;
        maxReservations: typeof PROMPT_REFINER_SHADOW_MAX_DISPATCHES;
        costCeilingMicroUsd: typeof PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD;
        reservationTtlMs: typeof PROMPT_REFINER_RESERVATION_TTL_MS;
    }>;
    readonly acknowledgements: readonly (typeof PROMPT_REFINER_SHADOW_STAGE_ACKNOWLEDGEMENTS)[number][];
};

function fail(code: string): never {
    throw new Error(`prompt_refiner_shadow_admission_${code}`);
}

function matches(pattern: RegExp, value: string): boolean {
    return (
        INTRINSIC_REFLECT_APPLY(INTRINSIC_REGEXP_EXEC, pattern, [value]) !==
        null
    );
}

function actualEvidenceByteLength(bytes: unknown, where: string): number {
    try {
        const byteLength = INTRINSIC_REFLECT_APPLY(
            TYPED_ARRAY_BYTE_LENGTH_GETTER,
            bytes,
            []
        );
        const tag = INTRINSIC_REFLECT_APPLY(
            TYPED_ARRAY_TAG_GETTER,
            bytes,
            []
        );
        if (
            tag !== "Uint8Array" ||
            !INTRINSIC_NUMBER_IS_SAFE_INTEGER(byteLength) ||
            byteLength < 0
        ) {
            return fail(`${where}_byte_limit`);
        }
        return byteLength;
    } catch {
        return fail(`${where}_byte_limit`);
    }
}

function snapshotEvidenceProperty(
    input: PromptRefinerShadowAdmissionEvidenceInput,
    property: keyof PromptRefinerShadowAdmissionEvidenceInput,
    maximum: number,
    where: string
): EvidenceBytes {
    let original: unknown;
    try {
        original = input[property];
    } catch {
        return fail(`${where}_byte_limit`);
    }
    const byteLength = actualEvidenceByteLength(original, where);
    if (byteLength > maximum) fail(`${where}_byte_limit`);
    try {
        const snapshot = new INTRINSIC_UINT8_ARRAY(byteLength);
        INTRINSIC_REFLECT_APPLY(INTRINSIC_UINT8_ARRAY_SET, snapshot, [
            original,
        ]);
        if (actualEvidenceByteLength(snapshot, where) !== byteLength) {
            return fail(`${where}_byte_limit`);
        }
        return snapshot;
    } catch {
        return fail(`${where}_byte_limit`);
    }
}

function preboundEvidenceInput(
    input: PromptRefinerShadowAdmissionEvidenceInput
): PreboundedAdmissionEvidenceInput {
    const manifestBytes = snapshotEvidenceProperty(
        input,
        "manifestBytes",
        MANIFEST_MAX_BYTES,
        "manifest"
    );
    const reportBytes = snapshotEvidenceProperty(
        input,
        "reportBytes",
        REPORT_MAX_BYTES,
        "report"
    );
    const journalBytes = snapshotEvidenceProperty(
        input,
        "journalBytes",
        PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES,
        "journal"
    );
    const witnessBytes = snapshotEvidenceProperty(
        input,
        "witnessBytes",
        PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES,
        "witness"
    );
    const corpusBytes = snapshotEvidenceProperty(
        input,
        "corpusBytes",
        CORPUS_MAX_BYTES,
        "corpus"
    );
    return {
        manifestBytes,
        reportBytes,
        journalBytes,
        witnessBytes,
        corpusBytes,
    } as PreboundedAdmissionEvidenceInput;
}

function sha256(bytes: Uint8Array | string): string {
    const hash = createHash("sha256");
    INTRINSIC_REFLECT_APPLY(INTRINSIC_HASH_UPDATE, hash, [bytes]);
    return INTRINSIC_REFLECT_APPLY(INTRINSIC_HASH_DIGEST, hash, ["hex"]);
}

function decodeJson(bytes: EvidenceBytes, maximum: number, where: string) {
    const byteLength = actualEvidenceByteLength(bytes, where);
    if (byteLength > maximum) {
        fail(`${where}_byte_limit`);
    }
    if (
        byteLength >= 3 &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf
    ) {
        fail(`${where}_bom`);
    }
    let text: string;
    try {
        const decoder = new INTRINSIC_TEXT_DECODER("utf-8", { fatal: true });
        text = INTRINSIC_REFLECT_APPLY(
            INTRINSIC_TEXT_DECODER_DECODE,
            decoder,
            [bytes]
        );
    } catch {
        return fail(`${where}_utf8`);
    }
    if (text[0] === "\ufeff") fail(`${where}_bom`);
    let parsed: unknown;
    try {
        parsed = parseBenchmarkJson(text, maximum);
    } catch {
        return fail(`${where}_json`);
    }
    return { text, parsed };
}

function decodeJournalBytes(bytes: EvidenceBytes, where: string): string {
    const byteLength = actualEvidenceByteLength(bytes, where);
    if (byteLength > PROMPT_REFINER_SHADOW_JOURNAL_MAX_BYTES) {
        fail(`${where}_byte_limit`);
    }
    if (
        byteLength >= 3 &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf
    ) {
        fail(`${where}_bom`);
    }
    let text: string;
    try {
        const decoder = new INTRINSIC_TEXT_DECODER("utf-8", { fatal: true });
        text = INTRINSIC_REFLECT_APPLY(
            INTRINSIC_TEXT_DECODER_DECODE,
            decoder,
            [bytes]
        );
    } catch {
        return fail(`${where}_utf8`);
    }
    if (text[0] === "\ufeff") fail(`${where}_bom`);
    return text;
}

function exactDigest(value: unknown, where: string): string {
    if (typeof value !== "string" || !matches(HEX_DIGEST_PATTERN, value)) {
        fail(`${where}_digest`);
    }
    return value;
}

function exactInteger(value: unknown, where: string): number {
    if (!INTRINSIC_NUMBER_IS_SAFE_INTEGER(value) || (value as number) < 0) {
        fail(`${where}_integer`);
    }
    return value as number;
}

function terminalHead(value: unknown, where: string): TerminalHead {
    const candidate = strictBenchmarkObject(
        value,
        ["seq", "entryDigest"],
        where
    );
    return {
        seq: exactInteger(candidate.seq, `${where}_seq`),
        entryDigest: exactDigest(candidate.entryDigest, `${where}_entry`),
    };
}

function evidenceFile(value: unknown, index: number): EvidenceFile {
    const candidate = strictBenchmarkObject(
        value,
        ["name", "sizeBytes", "sha256"],
        `admission_evidence_file_${index}`
    );
    const name = INTERNAL_ADMISSION_EVIDENCE_FILES[index];
    if (candidate.name !== name) fail("evidence_file_name_or_order");
    return {
        name,
        sizeBytes: exactInteger(candidate.sizeBytes, "evidence_file_size"),
        sha256: exactDigest(candidate.sha256, "evidence_file"),
    };
}

function parseManifest(bytes: EvidenceBytes): {
    manifest: AdmissionEvidenceManifest;
    rawSha256: string;
} {
    const { parsed } = decodeJson(bytes, MANIFEST_MAX_BYTES, "manifest");
    const candidate = strictBenchmarkObject(
        parsed,
        [
            "schemaVersion",
            "harnessVersion",
            "journalSchemaVersion",
            "sourceRef",
            "sourceIdentityDigest",
            "corpusDigest",
            "files",
            "journalTerminal",
            "witnessTerminal",
            "bundleDigest",
        ],
        "admission_evidence_manifest"
    );
    if (
        candidate.schemaVersion !==
            PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_VERSION ||
        candidate.harnessVersion !== PROMPT_REFINER_SHADOW_HARNESS_VERSION ||
        candidate.journalSchemaVersion !==
            PROMPT_REFINER_SHADOW_JOURNAL_VERSION ||
        typeof candidate.sourceRef !== "string" ||
        !matches(FULL_SHA_PATTERN, candidate.sourceRef) ||
        typeof candidate.sourceIdentityDigest !== "string" ||
        !matches(HEX_DIGEST_PATTERN, candidate.sourceIdentityDigest) ||
        typeof candidate.corpusDigest !== "string" ||
        !matches(HEX_DIGEST_PATTERN, candidate.corpusDigest) ||
        !INTRINSIC_ARRAY_IS_ARRAY(candidate.files) ||
        candidate.files.length !==
            INTERNAL_ADMISSION_EVIDENCE_FILES.length ||
        typeof candidate.bundleDigest !== "string" ||
        !matches(PREFIXED_DIGEST_PATTERN, candidate.bundleDigest)
    ) {
        fail("manifest_shape_or_version");
    }
    const manifest = {
        schemaVersion: candidate.schemaVersion,
        harnessVersion: candidate.harnessVersion,
        journalSchemaVersion: candidate.journalSchemaVersion,
        sourceRef: candidate.sourceRef,
        sourceIdentityDigest: candidate.sourceIdentityDigest,
        corpusDigest: candidate.corpusDigest,
        files: [
            evidenceFile(candidate.files[0], 0),
            evidenceFile(candidate.files[1], 1),
            evidenceFile(candidate.files[2], 2),
        ],
        journalTerminal: terminalHead(
            candidate.journalTerminal,
            "journal_terminal"
        ),
        witnessTerminal: terminalHead(
            candidate.witnessTerminal,
            "witness_terminal"
        ),
        bundleDigest: candidate.bundleDigest,
    } as AdmissionEvidenceManifest;
    return { manifest, rawSha256: sha256(bytes) };
}

function canonicalBundleDigest(
    manifest: AdmissionEvidenceManifest
): `sha256:${string}` {
    const body = {
        schemaVersion: manifest.schemaVersion,
        harnessVersion: manifest.harnessVersion,
        journalSchemaVersion: manifest.journalSchemaVersion,
        sourceRef: manifest.sourceRef,
        sourceIdentityDigest: manifest.sourceIdentityDigest,
        corpusDigest: manifest.corpusDigest,
        files: manifest.files,
        journalTerminal: manifest.journalTerminal,
        witnessTerminal: manifest.witnessTerminal,
    };
    return `sha256:${sha256(canonicalBenchmarkJson(body))}`;
}

function validateArtifactDigests(
    manifest: AdmissionEvidenceManifest,
    input: PreboundedAdmissionEvidenceInput
) {
    const artifacts = [
        { bytes: input.reportBytes, where: "report" },
        { bytes: input.journalBytes, where: "journal" },
        { bytes: input.witnessBytes, where: "witness" },
    ];
    for (
        let index = 0;
        index < INTERNAL_ADMISSION_EVIDENCE_FILES.length;
        index += 1
    ) {
        const file = manifest.files[index];
        const { bytes, where } = artifacts[index];
        if (
            actualEvidenceByteLength(bytes, where) !== file.sizeBytes ||
            sha256(bytes) !== file.sha256
        ) {
            fail("artifact_digest_or_size");
        }
    }
}

function sourceFiles(value: unknown): Record<string, string> {
    const candidate = strictBenchmarkObject(
        value,
        PROMPT_REFINER_SHADOW_SOURCE_PATHS,
        "report_source_files"
    );
    const files: Record<string, string> = {};
    for (
        let index = 0;
        index < PROMPT_REFINER_SHADOW_SOURCE_PATHS.length;
        index += 1
    ) {
        const path = PROMPT_REFINER_SHADOW_SOURCE_PATHS[index];
        files[path] = exactDigest(
            candidate[path],
            `report_source_file_${path}`
        );
    }
    return files;
}

function validateReport(
    reportBytes: EvidenceBytes,
    manifest: AdmissionEvidenceManifest
): { report: Record<string, unknown>; sourceFiles: Record<string, string> } {
    const { parsed } = decodeJson(reportBytes, REPORT_MAX_BYTES, "report");
    const report = strictBenchmarkObject(
        parsed,
        [
            "schemaVersion",
            "purpose",
            "dataClassification",
            "harnessVersion",
            "corpusDigest",
            "corpusCases",
            "sourceRef",
            "sourceIdentityDigest",
            "status",
            "stopReason",
            "resumable",
            "processedCases",
            "structuralBoundaryPopulation",
            "structuralBoundaryViolations",
            "behavioralOutcomePopulation",
            "behavioralOutcomeMatches",
            "remainingCases",
            "unknownCases",
            "providerCalls",
            "costMicroUsd",
            "source",
        ],
        "admission_evidence_report"
    );
    const source = strictBenchmarkObject(
        report.source,
        ["sourceRef", "identityDigest", "files"],
        "admission_evidence_report_source"
    );
    const files = sourceFiles(source.files);
    const recomputedSourceIdentity = promptRefinerShadowSourceIdentityDigest({
        sourceRef: manifest.sourceRef,
        files,
    });
    if (
        report.schemaVersion !== PROMPT_REFINER_SHADOW_JOURNAL_VERSION ||
        report.purpose !== "development-only" ||
        report.dataClassification !== "synthetic_test_only" ||
        report.harnessVersion !== PROMPT_REFINER_SHADOW_HARNESS_VERSION ||
        report.corpusDigest !== manifest.corpusDigest ||
        report.corpusCases !== PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        report.sourceRef !== manifest.sourceRef ||
        report.sourceIdentityDigest !== manifest.sourceIdentityDigest ||
        report.status !== "completed" ||
        report.stopReason !== null ||
        report.resumable !== false ||
        report.processedCases !== PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        report.structuralBoundaryPopulation !==
            PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        report.structuralBoundaryViolations !== 0 ||
        report.behavioralOutcomePopulation !==
            PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        report.behavioralOutcomeMatches !==
            PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        report.remainingCases !== 0 ||
        report.unknownCases !== 0 ||
        report.providerCalls !== 0 ||
        report.costMicroUsd !== 0 ||
        source.sourceRef !== manifest.sourceRef ||
        source.identityDigest !== manifest.sourceIdentityDigest ||
        recomputedSourceIdentity !== manifest.sourceIdentityDigest
    ) {
        fail("report_invariant");
    }
    return { report, sourceFiles: files };
}

function assertPinnedEvidence(
    manifest: AdmissionEvidenceManifest,
    manifestSha256: string
) {
    if (
        manifest.sourceRef !== PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF ||
        manifest.sourceIdentityDigest !==
            PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST ||
        manifest.corpusDigest !==
            PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST
    ) {
        fail("unreviewed_source_or_corpus");
    }
    if (
        canonicalBundleDigest(manifest) !== manifest.bundleDigest ||
        manifest.bundleDigest !==
            PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST
    ) {
        fail("bundle_digest");
    }
    if (manifestSha256 !== PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256) {
        fail("unchecked_manifest_bytes");
    }
}

function trustedUnsignedProposal(): Omit<
    PromptRefinerShadowStageProposal,
    "proposalDigest"
> {
    return {
        schemaVersion: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
        status: "awaiting_explicit_admin_cost_approval" as const,
        executionAdmitted: false as const,
        currentCheckoutValidated: false as const,
        runtimeSourceRevalidationRequired: true as const,
        evidenceBundleDigest:
            PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
        provenance: {
            sourceRef: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
            sourceIdentityDigest:
                PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
            corpusDigest: PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
            harnessVersion: PROMPT_REFINER_SHADOW_HARNESS_VERSION,
            journalSchemaVersion: PROMPT_REFINER_SHADOW_JOURNAL_VERSION,
        },
        reservationStage: {
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            perRequestCostMicroUsd:
                PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
            maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
            costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
            reservationTtlMs: PROMPT_REFINER_RESERVATION_TTL_MS,
        },
        acknowledgements: [
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[0],
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[1],
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[2],
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[3],
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[4],
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[5],
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[6],
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[7],
            INTERNAL_STAGE_ACKNOWLEDGEMENTS[8],
        ],
    };
}

function freezeTrustedProposal(
    proposal: Omit<PromptRefinerShadowStageProposal, "proposalDigest">
): PromptRefinerShadowStageProposal {
    INTRINSIC_OBJECT_DEFINE_PROPERTY(proposal, "proposalDigest", {
        value: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
        enumerable: true,
        configurable: false,
        writable: false,
    });
    INTRINSIC_OBJECT_FREEZE(proposal.provenance);
    INTRINSIC_OBJECT_FREEZE(proposal.reservationStage);
    INTRINSIC_OBJECT_FREEZE(proposal.acknowledgements);
    return INTRINSIC_OBJECT_FREEZE(
        proposal
    ) as PromptRefinerShadowStageProposal;
}

/**
 * Validates the frozen evidence and returns only a content-free proposal. A
 * successful return still has executionAdmitted=false and carries no approval
 * identity or timestamp.
 */
export function proposePromptRefinerShadowStage(
    input: PromptRefinerShadowAdmissionEvidenceInput
): PromptRefinerShadowStageProposal {
    const boundedInput = preboundEvidenceInput(input);
    const { manifest, rawSha256 } = parseManifest(boundedInput.manifestBytes);
    validateArtifactDigests(manifest, boundedInput);
    const reportValidation = validateReport(boundedInput.reportBytes, manifest);
    const report = reportValidation.report;

    const corpusText = decodeJson(
        boundedInput.corpusBytes,
        CORPUS_MAX_BYTES,
        "corpus"
    ).text;
    const corpus = parsePromptRefinerShadowCorpus(corpusText);
    if (
        corpus.contentDigest !== manifest.corpusDigest ||
        sha256(boundedInput.corpusBytes) !==
            reportValidation.sourceFiles[PROMPT_REFINER_SHADOW_CORPUS_PATH]
    ) {
        fail("corpus_digest");
    }

    const journalText = decodeJournalBytes(boundedInput.journalBytes, "journal");
    const witnessText = decodeJournalBytes(boundedInput.witnessBytes, "witness");
    const replay = replayPromptRefinerShadowJournal({
        journalText,
        witnessText,
        corpus,
        sourceIdentity: {
            sourceRef: manifest.sourceRef,
            identityDigest: manifest.sourceIdentityDigest,
        },
    });
    const terminal = replay.entries[replay.entries.length - 1];
    if (
        replay.status !== "completed" ||
        replay.resumable !== false ||
        replay.processedCases !== PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        replay.remainingCases !== 0 ||
        replay.unknownCases !== 0 ||
        replay.structuralBoundaryPopulation !==
            PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        replay.structuralBoundaryViolations !== 0 ||
        replay.behavioralOutcomePopulation !==
            PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        replay.behavioralOutcomeMatches !==
            PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        replay.providerCalls !== 0 ||
        replay.costMicroUsd !== 0 ||
        report.processedCases !== replay.processedCases ||
        !terminal ||
        terminal.seq !== manifest.journalTerminal.seq ||
        terminal.entryDigest !== manifest.journalTerminal.entryDigest ||
        manifest.witnessTerminal.seq !== manifest.journalTerminal.seq ||
        manifest.witnessTerminal.entryDigest !==
            manifest.journalTerminal.entryDigest
    ) {
        fail("replay_invariant_or_terminal_head");
    }
    assertPinnedEvidence(manifest, rawSha256);

    const proposal = trustedUnsignedProposal();
    const proposalDigest = `sha256:${sha256(
        canonicalBenchmarkJson(proposal)
    )}`;
    if (proposalDigest !== PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST) {
        fail("proposal_digest_drift");
    }
    return freezeTrustedProposal(proposal);
}
